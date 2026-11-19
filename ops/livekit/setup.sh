#!/usr/bin/env bash
# Set up and harden a single LiveKit media server on a fresh Ubuntu 24.04 LTS VM.
#
# Run as root, ON THE SERVER, after you have rented it yourself. This script
# does not order, rent or create anything anywhere. Read it first; it changes
# SSH, the firewall and automatic updates.
#
#   LIVEKIT_VERSION=v1.x.y \
#   LIVEKIT_DOMAIN=voice.example.org \
#   ADMIN_USER=ops \
#   ADMIN_SSH_PUBKEY="ssh-ed25519 AAAA... you@laptop" \
#   bash setup.sh
#
# Required:
#   LIVEKIT_VERSION     Pinned livekit-server image tag. No default on purpose:
#                       look up the current release and read its notes first.
#   LIVEKIT_DOMAIN      DNS name already pointing at this server (A/AAAA).
#   ADMIN_USER          Non-root login to create.
#   ADMIN_SSH_PUBKEY    That user's public key. Password login is turned off.
# Optional:
#   CADDY_VERSION       Default 2 (floating major tag of the official image).
#   AUTO_REBOOT_TIME    Default 04:00 (server time). Reboots end live calls, so
#                       pick a quiet hour; set to "never" to reboot by hand.
#
# What it sets up: see docs/ops/livekit-hardening.md for the reasoning and the
# checklist to verify afterwards.
set -euo pipefail

: "${LIVEKIT_VERSION:?set LIVEKIT_VERSION to a pinned release tag}"
: "${LIVEKIT_DOMAIN:?set LIVEKIT_DOMAIN}"
: "${ADMIN_USER:?set ADMIN_USER}"
: "${ADMIN_SSH_PUBKEY:?set ADMIN_SSH_PUBKEY}"
CADDY_VERSION="${CADDY_VERSION:-2}"
AUTO_REBOOT_TIME="${AUTO_REBOOT_TIME:-04:00}"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ "$ADMIN_USER" != "root" ]] || { echo "ADMIN_USER must not be root" >&2; exit 1; }
[[ "$ADMIN_SSH_PUBKEY" =~ ^(ssh-ed25519|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh.com)\  ]] \
  || { echo "ADMIN_SSH_PUBKEY must be an ed25519 or ecdsa public key" >&2; exit 1; }
[[ "$LIVEKIT_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "bad LIVEKIT_DOMAIN" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive

step() { printf '\n==> %s\n' "$*"; }

# ---------------------------------------------------------------- packages
step "Updating and installing packages"
apt-get update -y
apt-get upgrade -y
apt-get install -y --no-install-recommends ufw unattended-upgrades apt-listchanges docker.io ca-certificates openssl

# ---------------------------------------------------------------- admin user and SSH keys
step "Creating $ADMIN_USER with key-only login"
if ! id "$ADMIN_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$ADMIN_USER"
fi
usermod -aG sudo "$ADMIN_USER"
install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "/home/$ADMIN_USER/.ssh"
printf '%s\n' "$ADMIN_SSH_PUBKEY" > "/home/$ADMIN_USER/.ssh/authorized_keys"
chown "$ADMIN_USER:$ADMIN_USER" "/home/$ADMIN_USER/.ssh/authorized_keys"
chmod 600 "/home/$ADMIN_USER/.ssh/authorized_keys"
# sudo without a password, since the account has none. Access is the key.
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$ADMIN_USER" > "/etc/sudoers.d/90-$ADMIN_USER"
chmod 440 "/etc/sudoers.d/90-$ADMIN_USER"
visudo -cf "/etc/sudoers.d/90-$ADMIN_USER" >/dev/null

# ---------------------------------------------------------------- SSH hardening
step "Hardening sshd"
cat > /etc/ssh/sshd_config.d/99-bastion-hardening.conf <<EOF
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers ${ADMIN_USER}
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
PermitEmptyPasswords no
# Do not write the connecting address into the auth log.
LogLevel QUIET
EOF
sshd -t
systemctl reload ssh
echo "sshd reloaded. KEEP THIS SESSION OPEN and test a second login as $ADMIN_USER before closing it."

# ---------------------------------------------------------------- firewall
step "Configuring the firewall (default deny)"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp comment 'ssh, rate limited'
ufw allow 80/tcp comment 'ACME http-01 and redirect'
ufw allow 443/tcp comment 'signaling over TLS (Caddy)'
ufw allow 7881/tcp comment 'WebRTC over TCP fallback'
ufw allow 3478/udp comment 'TURN over UDP'
ufw allow 50000:60000/udp comment 'WebRTC media'
# The firewall keeps no log of who connected.
ufw logging off
ufw --force enable

# ---------------------------------------------------------------- logs without IPs
step "Keeping logs small, short lived and in memory"
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/99-bastion.conf <<EOF
[Journal]
# In memory only: nothing survives a reboot, and nothing is written to disk.
Storage=volatile
RuntimeMaxUse=50M
MaxRetentionSec=3day
EOF
systemctl restart systemd-journald

# ---------------------------------------------------------------- automatic updates
step "Turning on automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<EOF
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
{
  echo 'Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";'
  echo 'Unattended-Upgrade::Remove-Unused-Dependencies "true";'
  if [[ "$AUTO_REBOOT_TIME" == "never" ]]; then
    echo 'Unattended-Upgrade::Automatic-Reboot "false";'
  else
    echo 'Unattended-Upgrade::Automatic-Reboot "true";'
    echo "Unattended-Upgrade::Automatic-Reboot-Time \"${AUTO_REBOOT_TIME}\";"
  fi
} > /etc/apt/apt.conf.d/52bastion-unattended
systemctl enable --now unattended-upgrades

# ---------------------------------------------------------------- LiveKit
step "Writing the LiveKit config"
install -d -m 750 /etc/livekit
API_KEY="API$(openssl rand -hex 8)"
API_SECRET="$(openssl rand -hex 32)"

# Deliberately absent: egress, ingress, webhooks, redis, prometheus, any
# telemetry. Cameras are never granted by the Worker's tokens either.
cat > /etc/livekit/livekit.yaml <<EOF
port: 7880
bind_addresses:
  - "127.0.0.1"
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
turn:
  enabled: true
  domain: ${LIVEKIT_DOMAIN}
  udp_port: 3478
keys:
  ${API_KEY}: ${API_SECRET}
# warn keeps routine connection details, which include addresses, out of the logs.
logging:
  level: warn
  pion_level: error
  sample: true
room:
  auto_create: true
  empty_timeout: 60
  departure_timeout: 20
  max_participants: 100
EOF
chmod 640 /etc/livekit/livekit.yaml
chgrp docker /etc/livekit/livekit.yaml || true

cat > /etc/livekit/Caddyfile <<EOF
{
	admin off
	# Caddy's own log goes nowhere; there is no access log directive below.
	log {
		output discard
	}
}

${LIVEKIT_DOMAIN} {
	reverse_proxy 127.0.0.1:7880
}
EOF

step "Installing systemd units"
cat > /etc/systemd/system/livekit.service <<EOF
[Unit]
Description=LiveKit server
After=docker.service network-online.target
Requires=docker.service

[Service]
Restart=always
RestartSec=3
ExecStartPre=-/usr/bin/docker rm -f livekit
ExecStart=/usr/bin/docker run --rm --name livekit --network host \\
  --read-only --cap-drop ALL --security-opt no-new-privileges \\
  -v /etc/livekit/livekit.yaml:/etc/livekit.yaml:ro \\
  livekit/livekit-server:${LIVEKIT_VERSION} --config /etc/livekit.yaml
ExecStop=/usr/bin/docker stop livekit

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/caddy-livekit.service <<EOF
[Unit]
Description=Caddy TLS front for LiveKit
After=docker.service network-online.target livekit.service
Requires=docker.service

[Service]
Restart=always
RestartSec=3
ExecStartPre=-/usr/bin/docker rm -f caddy-livekit
ExecStart=/usr/bin/docker run --rm --name caddy-livekit --network host \\
  --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges \\
  -v /etc/livekit/Caddyfile:/etc/caddy/Caddyfile:ro \\
  -v caddy-livekit-data:/data \\
  --tmpfs /config \\
  caddy:${CADDY_VERSION}
ExecStop=/usr/bin/docker stop caddy-livekit

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now docker livekit caddy-livekit

# ---------------------------------------------------------------- done
cat <<EOF

==> Done.

Store these as Worker secrets. They are shown once and not logged anywhere:

  LIVEKIT_URL=wss://${LIVEKIT_DOMAIN}
  LIVEKIT_API_KEY=${API_KEY}
  LIVEKIT_API_SECRET=${API_SECRET}

  wrangler secret put LIVEKIT_API_KEY --env <env>
  wrangler secret put LIVEKIT_API_SECRET --env <env>
  (LIVEKIT_URL is not secret; set it under [env.<env>.vars] in wrangler.toml)

Now work through docs/ops/livekit-hardening.md, "After running the script".
EOF
