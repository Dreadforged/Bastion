import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

export interface RelyingParty {
  id: string;
  name: string;
  origin: string;
}

export interface StoredCredential {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports?: string[];
}

/**
 * Thin wrapper over SimpleWebAuthn so the account logic can be tested
 * without real authenticators. No WebAuthn crypto is done outside the library.
 */
export interface Passkeys {
  registrationOptions(user: {
    id: string;
    email: string;
    exclude: string[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(
    response: RegistrationResponseJSON,
    expectedChallenge: string,
  ): Promise<StoredCredential | null>;
  authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthentication(
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
    credential: StoredCredential,
  ): Promise<{ newCounter: number } | null>;
}

export function simpleWebAuthn(rp: RelyingParty): Passkeys {
  return {
    registrationOptions(user) {
      return generateRegistrationOptions({
        rpName: rp.name,
        rpID: rp.id,
        userName: user.email,
        userID: new Uint8Array(new TextEncoder().encode(user.id)),
        attestationType: "none",
        excludeCredentials: user.exclude.map((id) => ({ id })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      });
    },

    async verifyRegistration(response, expectedChallenge) {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: true,
      });
      if (!result.verified) return null;
      const { credential } = result.registrationInfo;
      return {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        ...(credential.transports ? { transports: credential.transports } : {}),
      };
    },

    authenticationOptions() {
      // Discoverable credentials: the browser picks the account, so no email is needed.
      return generateAuthenticationOptions({ rpID: rp.id, userVerification: "required" });
    },

    async verifyAuthentication(response, expectedChallenge, credential) {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        credential,
        requireUserVerification: true,
      });
      return result.verified ? { newCounter: result.authenticationInfo.newCounter } : null;
    },
  };
}
