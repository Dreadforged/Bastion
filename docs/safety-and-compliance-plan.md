# Safety and compliance plan

Status: draft v1, written 2026-11-19. Planning only: nothing here is built.

**This is research and engineering planning, not legal advice.** Laws below were
read from news, law-firm and agency pages found by web search on 2026-11-19, and
several of those sources disagree on dates. Each item is labelled **Law** (in
force), **Guidance** (official but not binding), **Proposed** (not law), or
**Unconfirmed** (I could not verify it). A lawyer must confirm everything in
section 2 before it drives a decision.

Limits of this pass: the technical design, product brief, GTM, and
self-hosting scope documents were not available on this machine (the upload
folder was empty), so the product details below come only from the repo and its
docs. Where a design decision matters (for example whether server channels can
ever be plaintext), it is listed as a question.

---

## 1. Summary

### What Nicole heard about EU URL blocking: not confirmed

The claim was that the EU now blocks URLs for adult content regardless of who
sends and receives, and that this is illegal. I found nothing that says that.
The nearest real things are:

1. **Regulation (EU) 2026/1881 (Law).** It restores, until 3 April 2028, a
   temporary exception that lets messaging providers *voluntarily* scan for
   child sexual abuse material (CSAM). It is voluntary, and it expressly does
   not cover end-to-end encrypted communications. It is about CSAM, not adult
   content in general, and not URL blocking.
2. **The permanent "chat control" CSA Regulation (Proposed).** Still in
   negotiation. The 2022 proposal included orders to scan and, as I recall it,
   orders for network providers to block access to specific CSAM URLs. I could
   not confirm in this research whether blocking orders survive in either
   institution's current text. The Council's November 2025 position dropped
   mandatory detection orders.
3. **National adult-site laws (Law, per country).** France and Italy require age
   checks on adult sites and France lets its regulator order ISPs to block
   non-compliant sites. That targets the sites, not messages between people.

So the accurate version is: no EU-wide rule that I could find makes a chat
service block adult URLs between users. Scanning of private messages is
voluntary and excludes E2EE today; a mandatory version is still being fought
over. Whether any given national rule is "illegal" is a legal question I cannot
answer. It would be worth asking where she saw it.

### Top risks

1. **Public surfaces are unscanned.** `NoopScanner` lets every public image
   through. One public CSAM upload, with no report path to NCMEC, is the
   single worst outcome for the company, legally and morally.
2. **No platform-level reporting or takedown path.** Reports go only to each
   server's moderators. There is no way for a user, the public, an authority or
   a trusted flagger to reach *us*, no internal admin tool, and no evidence
   handling. EU and US law both assume such a path exists.
3. **No minor-safe defaults and no age signal at all.** Today there is no age
   field, no user blocking, and DMs default to `everyone`. Regulators' current
   benchmarks (EU Article 28 guidelines, UK Ofcom codes) are built around
   unsolicited contact with children, and DMs from strangers are exactly that.
4. **Public stance on encryption is not written down.** If E2EE content can't be
   scanned (true by design), the defensible position is "we do everything
   possible *around* it", stated plainly, with a red line against client-side
   scanning. That needs to be decided, not drifted into.
5. **Legal entity and representation.** Reaching EU and UK users from the US
   typically brings obligations such as an EU legal representative and
   contact points. A lawyer should confirm before any EU invite.
6. **Retention conflicts.** US law requires preserving reported material for one
   year; the audit log and reports are deleted after 90 days and the privacy
   notes say IPs are never stored. These need an explicit, narrow carve-out.

### Decisions Nicole must make

| # | Decision | Recommendation |
| - | --- | --- |
| 1 | Where the alpha is open | US only, invite only. Open EU after Phase 2 below, UK after Phase 3. |
| 2 | **Decided by Nicole, 2026-11-19:** the alpha is 18+, and the plan assumes some minors will lie about their age and Bastion will still be held responsible for safety tooling. | Done. Safeguards, reporting, age signals and minor detection are built for "children are present anyway" (section 1A). A later move to 13+ (or 16+ in some EU countries) is a flag change after the lawyer agrees. |
| 3 | Public-channel image and file uploads | Keep off until a hash-matching scanner and the NCMEC report path both work. |
| 4 | Written encryption red line | Publish: no client-side scanning, no key escrow, no backdoor; we act on public content, uploads, reports and metadata we legitimately hold. |
| 5 | Who handles CSAM reports | A named person plus lawyer-approved procedure before launch. Staff must not be asked to open material without legal guidance. |
| 6 | Scanner and age-assurance vendors | Pick after the lawyer confirms what is required (see Phase 1/2). They become subprocessors. |
| 7 | Adult (NSFW) channels | Disallow in the alpha. If allowed later, gate behind verified 18+ and off by default in regions that require strong age verification. |

### Plan at a glance

All safety features are **modules switched by region flags** that can be turned
on in production without a release (section 5). Sizes are one engineer:
S under 1 week, M 1 to 3 weeks, L 3 to 8 weeks.

| Phase | Goal | Engineering size |
| --- | --- | --- |
| 0 | Before the first invite | L total |
| 1 | Alpha launch, US | M to L |
| 2 | Open to the EU | L |
| 3 | UK and everything else, ongoing watch | M, then ongoing |

---

## 1A. Minimum age: what is decided, and what 13+ versus 18+ changes

(Added 2026-11-19 after Nicole's follow-up.)

### What is actually decided

Nothing that I can find. I searched the Bastion repo and docs and the other
Dreadforged folders on this machine for a minimum age, "13+", "18+", COPPA, or
"minor". There is no age field on the account, no age in any doc, and no
terms of service yet. The product brief and technical design were not
available to me, so if 13+ is written in one of them, it needs to be copied
into the repo. Until then, the honest status is **undecided**. Discord's rule is
(from my memory, not checked in this pass) 13, or higher where local law
requires it.

### Decided 2026-11-19: 18+ alpha, designed for children being present anyway

Nicole decided the alpha is **18+**, and asked that the plan assume **some
minors will lie about their age and Bastion will still be held responsible for
safety tooling**. That is the right assumption, and it changes the design in
five ways:

1. **An age declaration is a claim, not a fact.** We record it as a band that
   expires (never a birth date), mark it `declared`, and treat anything that
   contradicts it as evidence.
2. **Evidence comes only from places we may legitimately look.** Age signals
   are: a user report that an account is underage (new report category
   `underage`), a moderator or staff flag, the person declaring a *younger* age
   after claiming to be an adult, a mismatch between the declared country and
   the connection country (weak), and later an age estimation result or app
   store age signal. **None of them reads messages, voice or encrypted files.**
   The "red lines" in section 4 stand.
3. **Signals add up, and enough of them trigger a review, not a punishment.**
   Each signal has a weight and expires after six months. At the region's
   threshold the account moves to `pending_age_review`. The planned response
   ladder: (a) ask for a stronger age check (estimation, the EU age app, or a
   vendor); (b) if passed, back to normal and further signals are ignored;
   (c) if failed or ignored, the account becomes `restricted` (below the
   region's minimum age) and can read and export but not use the service; (d) if
   under 13, it is removed and the data deleted (a legal hold overrides if
   evidence must be kept).
4. **Retrying does not work.** A younger declaration after an adult one is
   accepted and counted as a strong signal. An older one is ignored. A declared
   age under 13 removes the account. Age declarations are limited to five an
   hour. The remaining gap is a new account under a new email, which no age
   declaration can stop and which is why the stronger checks and reporting matter.
5. **Teen-safe defaults and contact controls are built regardless.** If a
   13 to 17 year old is on the service, the defaults protect them even before the
   age review finishes. That is the point of building them in Phase 0 and not
   waiting for the minimum age to drop.

**Why the liability point matters.** Regulators judge what a service did
*given that children use it*, not only what its terms say. In practice the
questions are: did you assess the risk to children, did you act on reports
quickly, did you build sensible defaults, did you try proportionate age
assurance, and can you show records. The groundwork below produces those
records (age signals, reason codes, staff access log, flag history).

### What each choice means, in plain language

| | **18+ only** | **13+ (like Discord)** |
| --- | --- | --- |
| US under-13 rules (COPPA) | You still must not knowingly keep an under-13's data. If you learn a child that young is on, you delete the account. Same under both options. | Same. 13+ means you refuse under-13s and remove them when you learn of them. Do not build features aimed at younger children. |
| EU/UK data law on children (GDPR "age of digital consent", 13 to 16 depending on the country) | Mostly avoided, but you still have a duty to act if you find out a child is on. | If a child's data is processed on the basis of their consent, a country with a higher age (up to 16) wants a parent's permission below that age. Whether that applies depends on the legal basis you use, so this is a lawyer question. The practical fix: 13+ in some countries, 16+ in others, set by a region flag. |
| EU minors guidelines (DSA Article 28), UK Online Safety Act child duties, UK Children's Code | These apply to services children are *likely to use*, not only to services that allow them. A rule in the terms that says 18+ does not remove the duty if teenagers are in practice there. I believe the UK regulator expects strong age checks before a service can claim children cannot get in, **Unconfirmed**; ask the lawyer. So 18+ lowers the risk but does not make it go away unless age checks are strong. | The full set applies: private-by-default teen accounts, blocking and muting, no group adds without consent, no engagement-bait features, easy reporting with feedback, a children's risk assessment in the UK. |
| Age assurance (how you check) | Self-declaration is a floor. Stronger checks are needed only for adult content or if you want to rely on "no children". | Self-declaration plus a plan for stronger checks where a country requires them (age estimation, or the EU age-verification app). Declared age is also what sets teen defaults. |
| Teen defaults (private profile, DMs from strangers off, etc.) | Built but rarely triggered. | Core product. A 13 to 17 account must feel different from an adult account from the first screen. |
| Parental controls | Not needed. | The EU guidelines expect some parental tooling. With end-to-end encryption a parent cannot see message content, only what we know as metadata, such as joined servers and new contacts. Decide later whether to build a "family link". |
| Moderation load and risk | Lower, because grooming and exploitation risk is much lower. | Higher. More reporting, more urgent cases, more weight on the child-safety workflow and NCMEC reporting. |
| Terms, privacy page, consent records | Simple. | Plain-language teen version of the privacy notice (the UK Children's Code expects it). Record which version of the terms each user accepted. |

### Recommendation

1. **Closed alpha: 18+**, declared at sign-up. It is the cheapest way to start
   with a small number of trusted communities while the safety tools are built.
2. **Build for 13+ now**, so the product never has to be redesigned. The
   teen defaults, contact controls and reporting in Phase 0 are the same work
   either way. The age rule is a flag value (`safety.age.min_age` per region),
   not a code change.
3. **Open 13+ only after Phase 2**, with the lawyer's answers on consent ages
   (13 to 16 by country) and children's risk assessments. Likely end state:
   13+ in most regions, 16+ where the lawyer says so, set by region flag.
4. Whatever you choose, **write it down in the terms and enforce it the same
   way**: refuse sign-up under the minimum, act on reports of underage users,
   delete underage accounts promptly. A rule on paper that is not enforced is
   worse than none.

Decision 2 in section 1 is the one Nicole needs to confirm.

### What else to build in now so later compliance is cheap

These are small things that are painful to retrofit and are **not in the
Phase 0 list above** (section 6 is updated to include them). Most are columns,
states or records rather than finished features.

1. **Terms and policy versioning**: store which version of the terms and
   privacy notice each account accepted, and when. Needed to re-ask after a
   change and to prove consent.
2. **Account states beyond active/deleted**: `suspended`, `restricted`,
   `pending_age_review`, `underage_removed`. Lets safety actions and
   age-based lockouts happen without deleting evidence or the account.
3. **Legal hold**: a flag on an account, server or file that stops normal
   deletion and expiry while an investigation or preservation duty is open.
   Without it, account deletion (a launch gate) can destroy evidence the law
   says to keep.
4. **Retention as configuration, not constants.** `MODERATION_LIMITS.retentionMs`
   is a hard-coded 90 days. Retention per data type and per region should be a
   flag value so a legal change is a setting.
5. **Structured reason codes** on every moderation and platform action, plus a
   record of what the affected user was told and whether they appealed. The
   audit log today has free-text reasons only. The EU rules on explaining
   removals are easy to meet if the data is there from the start.
6. **Age-restricted labels** on channels and servers, even while adult content
   is disabled. Adding the label later means migrating every existing server.
7. **Age signals from outside**: a slot to accept an age signal from an app
   store or the EU age-verification app (Texas-style app-store laws send these
   to developers). Only needed when the desktop or mobile builds ship through
   stores.
8. **Message-request state in the conversation setup.** Design now that a
   first-contact DM or group invite is a pending request and key material is
   released only on accept. It is hard to add to the encryption flow later.
9. **Guardian link (placeholder only)**: a table and API shape for a parent or
   guardian relationship, unused until the lawyer says it is needed.
10. **A parent or guardian deletion and contact route**: a published way for a
    parent to ask for a child's account to be removed, with staff procedure. Cheap,
    and US and EU rules expect it for under-age accounts.
11. **Hash store for removed content**: a table of hashes of files removed for
    abuse or intimate-image reports, so identical copies are blocked later.
12. **Staff access log**: every staff view of a report or evidence item is
    logged, and staff roles are limited. Needed for the evidence vault and
    for a data protection audit.
13. **Records of processing and the subprocessor register**, kept in the repo,
    including any scanner and age-check vendors once chosen.
14. **Country on the account** (country code only, never an IP), as in
    section 5. It cannot be rebuilt later for existing users.
15. **Age stored as a band with the month it expires, not a birth date.** For
    example `13to15, valid until 2027-03` so a user moves to the next band
    automatically. Confirm with the lawyer that this is enough.

---

## 2. The law, as best I could confirm it (2026-11-19)

### EU

| Item | Status | What it means for Bastion | Source |
| --- | --- | --- | --- |
| Regulation (EU) 2026/1881, temporary derogation from ePrivacy Directive for voluntary CSAM detection | **Law.** Adopted 24 July 2026, in force three days after publication on 28 July 2026, applies until 3 April 2028. The earlier version lapsed 3 April 2026, so there was a gap. | Lets providers scan voluntarily. Not an obligation. **Does not apply to E2EE communications**, and says it must not be read as weakening or circumventing E2EE. Sources agree on the dates; one account says Parliament acted on 9 July and another on 26 March for the earlier rejection. | [eucrim](https://eucrim.eu/news/interim-rules-on-voluntary-csam-detection-reinstated-until-2028/), [Euronews](https://www.euronews.com/my-europe/2026/07/28/why-is-chat-control-one-of-the-eus-biggest-digital-rights-fights) |
| Permanent CSA Regulation ("chat control 2.0") | **Proposed.** Commission proposal 11 May 2022. Parliament position November 2023 (narrower, excludes E2EE from detection orders). Council position 26 November 2025 (no mandatory detection orders, risk assessment and mitigation, removal orders, EU Centre, voluntary scanning made permanent, E2EE recital). Trilogues ongoing, some sources mention rounds in September and December 2026. | Could one day impose risk assessments and mitigation duties even without scanning. Critics warn mitigation duties could pressure E2EE providers. Final outcome unknown. I could not confirm the December date. | [eucrim on Council position](https://eucrim.eu/news/csa-regulation-council-position-reached/), [EP legislative train](https://www.europarl.europa.eu/legislative-train/theme-promoting-our-european-way-of-life/file-combating-child-sexual-abuse-online) |
| Digital Services Act (DSA), Regulation (EU) 2022/2065 | **Law.** | Applies to online services offered to people in the EU, wherever the provider is based. Core duties for hosting services include a contact point, a legal representative for non-EU providers, clear terms, a notice-and-action mechanism, and reasons given when content is removed. **Micro and small enterprises are exempt from the extra platform duties (Articles 19 to 28), but I believe not from the hosting-service basics (including Article 16 notice-and-action and Article 13 legal representative).** I could not confirm those two points from the sources I retrieved. | [Article 19 text summaries](https://www.springlex.eu/en/packages/dsa/dsa-regulation/article-19/) |
| DSA Article 28 guidelines on protecting minors | **Guidance** (non-binding), published 14 July 2025. Used by the Commission to assess compliance. Applies to online platforms accessible to minors (micro and small enterprises are excluded from the platform duties). | Minors' accounts private by default. Minors can block and mute anyone and cannot be added to groups without consent. Streak, read-receipt and push-style engagement features off by default. Age verification recommended for adult content and where national law sets a minimum age; age estimation for other cases. Better reporting with prompt feedback. | [Commission page](https://digital-strategy.ec.europa.eu/en/library/commission-publishes-guidelines-protection-minors) |
| EU age-verification blueprint / app | **Guidance and pilots.** First version 14 July 2025, second version 10 October 2025. Pilots in Denmark, France, Greece, Italy, Spain, with a 2026 Commission recommendation asking Member States to deploy by 31 December 2026 (one vendor source, **Unconfirmed**). Open source, privacy-preserving proof of "over 18". | A privacy-friendly way to get age assurance without Bastion holding IDs. Plan to integrate when stable. Not a legal requirement to adopt. | [Commission](https://digital-strategy.ec.europa.eu/en/news/commission-makes-available-age-verification-blueprint) |
| GDPR and ePrivacy Directive | **Law.** | ePrivacy confidentiality of communications is why scanning private messages needs a specific exception (2026/1881) at all. Scanning *public* content is a different question for a lawyer. GDPR still applies to reports, evidence and age data: lawful basis, data minimisation, a data protection impact assessment, and special care for children's data. The age at which a child can consent to data processing varies by Member State (13 to 16): **Unconfirmed**, ask the lawyer. |  |
| National adult-site age verification and blocking (France, Italy and others) | **Law, per country.** | Aimed at adult sites and ISPs, not chat services. Becomes relevant if Bastion hosts adult content. | [Yahoo News overview](https://ca.news.yahoo.com/age-verification-era-eu-countries-060103914.html) |

### UK

| Item | Status | Meaning | Source |
| --- | --- | --- | --- |
| Online Safety Act, illegal content and child safety duties | **Law**, enforced by Ofcom. Child safety duties in force since July 2025. Ofcom said in August 2026 that announcements about future measures do not change current duties. | Applies to services with UK users regardless of where they are based and, in my understanding, regardless of size: an illegal content risk assessment, a children's risk assessment if children can use the service, reporting and complaints tools, and reporting detected CSEA to the National Crime Agency. Ofcom has specifically named encrypted messaging as a risk area. | [Ofcom roadmap](https://www.ofcom.org.uk/online-safety/information-for-industry/roadmap-to-regulation), [children's duties](https://www.ofcom.org.uk/online-safety/protecting-children/protection-of-children-duties-under-the-online-safety-act) |
| Scanning private messages | Ofcom cannot, per one source (IWF), direct providers to use proactive technology in private communications; separately, section 121 allows accredited technology notices for CSEA, including in private messaging. Hash-matching expectations apply mainly to larger or high-risk image-sharing services. | Plausible position: hash-match public image uploads, no scanning of E2EE DMs. Confirm with a UK lawyer. | [IWF](https://www.iwf.org.uk/policy-work/the-online-safety-act-explained) |
| Ofcom draft code on proactive technology, dated November 2026 | **Proposed**, status unconfirmed. | Watch. | [Ofcom draft](https://www.ofcom.org.uk/siteassets/resources/documents/consultations/category-1-10-weeks/consultation-online-safety---additional-safety-measures/code-docs/draft-illegal-content-code-of-practice-for-user-to-user-services---proactive-technologies.pdf) |

### United States

| Item | Status | Meaning | Source |
| --- | --- | --- | --- |
| 18 U.S.C. 2258A, as amended by the REPORT Act (signed 7 May 2024) | **Law.** | Providers must report apparent CSAM and certain other child exploitation offences to NCMEC's CyberTipline once they have actual knowledge. There is **no duty to scan or monitor**. Preservation of report contents is now **one year** (was 90 days). Also cybersecurity expectations for how preserved material is held. Penalties for failing to report increased. | [Wilson Sonsini](https://www.wsgrdataadvisor.com/2024/05/new-minor-safety-obligations-for-online-services-report-act-expands-child-sexual-exploitation-reporting-requirements/), [Public Law 118-59](https://www.congress.gov/118/plaws/publ59/PLAW-118publ59.htm) |
| TAKE IT DOWN Act | **Law**, platform notice-and-removal duties enforceable since 19 May 2026. | Covered platforms need a way for victims to request removal of non-consensual intimate images, clear notice of it, and removal within 48 hours, plus reasonable efforts to remove known identical copies. FTC began enforcing in May 2026. Applies to what we can see and remove, meaning public content. | [FTC](https://www.ftc.gov/business-guidance/resources/complying-take-it-down-act) |
| App-store age verification (Texas SB 2420, Utah, Louisiana, Alabama) | **Law, contested.** Texas enforceable after the Fifth Circuit stay and the Supreme Court declining to intervene (May 2026); Utah delayed to 2027 per one source (**Unconfirmed**). | Aimed at app stores, but developers receive age signals. Relevant mainly if the desktop app ships through stores. | [Texas Tribune](https://www.texastribune.org/2026/05/28/texas-apple-google-app-store-age-verification/) |
| Federal kids' online safety bills (KOSA, House KIDS Act) | **Proposed.** House passed the KIDS Act on 29 June 2026 (267 to 117). Senate Commerce advanced its KOSA on 5 August 2026. No enactment found. Status after about September is unknown. | Watch. | [CRS](https://www.everycrsreport.com/files/2026-08-24_IF12730_584f068130570c3b8485457e58a3a05dcae55406.html) |
| COPPA (under-13 data rules) | **Law.** Amended rule compliance date reported as 22 April 2026: **Unconfirmed**. | Easiest to avoid by not allowing under-13s. | |
| State social-media and age-assurance laws (many states) | **Not researched** in this pass. Several are known to be in litigation. | A lawyer should list the ones that apply to a chat service and are not enjoined. | |

---

## 3. What exists today versus gaps

Based on the repo as of 2026-11-19.

| Area | Exists | Gap |
| --- | --- | --- |
| Reporting | Server-level reports (`workers/shared/src/moderation.ts`): categories incl. `sexual`, `illegal`; reporter chooses up to 25 messages, decrypted on their device; reporter hidden from moderators; closed reports kept 90 days | No report to the *platform*; no reporting of users, servers, profiles, invites; no appeal; no reasons-given notice to the reported user; no category for child safety specifically; no acknowledgment flow for reporters |
| Moderation | Timeouts, kicks, bans (with message deletion), slow mode, audit log (90 days), voice disconnect and stream end | No platform-level actions (ban an account everywhere, suspend a server); no internal admin tool (listed as not built); no evidence vault |
| File scanning | Hook `ImageScanner` in `workers/api/src/files/scanner.ts` with verdicts clean, match, error; EXIF strip; separate files domain; magic-byte type check | Only `NoopScanner`; nothing reports a match anywhere; no hash list; private files are intentionally unscanned. Launch checklist already forbids public uploads until fixed |
| E2EE | MLS for DMs, private channels, voice; server sees only ciphertext | By design, nothing to scan server-side. Server-channel `Message` is also ciphertext in the current schema, so it is unclear whether any *plaintext* public text exists (question for the design) |
| Privacy settings | `dm_policy` (everyone or nobody), typing indicators; enforced in the Worker | No age field, no block list, no message requests, no group-add consent, default is `everyone` |
| Account | Passkeys, device approval, data export | Account deletion missing (launch gate); no age or region on the account |
| Rate limits | Per-IP and per-user limits on auth, uploads | No limit on creating DMs to many strangers, joining many servers, or mass invites |
| Threat model and checklist | Lists "abuse of platform" as design only; stub scanner; admin tool not built | No safety section in the legal checklist beyond "terms, privacy policy, abuse contact" |
| Feature flags | None found (grep for flags, country, birth fields found nothing relevant) | Entire section 5 |
| Retention | Reports and audit 90 days; IP never stored | Preservation duty needs an exception (section 4, module 3) |

---

## 4. Safety modules

The central constraint: **DMs, private channels and voice are end-to-end
encrypted, so Bastion cannot scan or read them, and should say so.** Everything
below works on content and signals the server legitimately holds (public
uploads, profiles, invites, account metadata), plus what a user chooses to
report, plus defaults that reduce the chance of harm in the first place.

**Red lines (proposed, Decision 4):**

- No client-side scanning of encrypted content that reports to the server. This
  is the mechanism "chat control" opponents reject and would break the product's
  claim.
- No key escrow, weakened keys, or hidden recipient.
- A user's report is the user disclosing what they themselves received. That is
  the supported route into encrypted spaces.

Each module has a **flag name**, which can be on, off, or configured per region
(section 5).

### Module 0: Flag service and safety audit log (`safety.core`)

Foundation for everything else. Region-resolved flags, an append-only log of who
changed which flag and when, and a jurisdiction resolver. **M.**

### Module 1: Platform reporting and notice-and-action (`safety.reports`)

- "Report to Bastion" for servers, users, public files, invites and profiles,
  reachable without an account for public content (a web form with rate limits).
- Child-safety and illegal-content categories get priority.
- Reporter gets an acknowledgment and an outcome notice (this is what the EU
  guidelines ask for in spirit; the exact legal form is a lawyer question).
- Acting on a report produces a **statement of reasons** to the affected user,
  with an appeal path.
- Reuses the existing report shape; adds a platform queue and the internal admin
  tool behind Cloudflare Access (hardware key).
- Fits encrypted spaces: the reporter attaches the messages they choose, as today.
- Voice and live streams: no recording; a reporter can submit a clip or notes, a
  moderator can disconnect or end a stream (exists), and platform staff can
  suspend a server.

**L.**

### Module 2: Public-surface checks (`safety.public_scan`)

Only for content the server can legitimately see:

- Hash matching of public images and files via the existing `ImageScanner`
  hook, against a vendor or industry hash list. Candidates to evaluate (names
  only, none verified in this pass): Cloudflare's CSAM scanning tool, Microsoft
  PhotoDNA, Thorn Safer, IWF hash lists. A match deletes the file, preserves
  evidence (Module 3), and triggers a report.
- Fix the `error` verdict so a failing scanner never lets files through.
- Link and URL handling on *public, server-visible* fields only (invite
  names, server descriptions, profiles, usernames): checked against a
  blocklist of known abuse domains. Message text is ciphertext, so the server
  cannot check URLs in messages, and **client-side link warnings** are the
  feasible alternative: the client checks a downloaded blocklist locally and
  warns the reader. It reports nothing to the server. The lawyer should
  confirm this stays outside "scanning" for the red line.
- Same-day removal for known intimate-image abuse reports (TAKE IT DOWN):
  hash of removed items so identical copies are blocked on upload.

**M for the scanner integration, plus a vendor decision.**

### Module 3: Evidence vault and NCMEC / authority reporting (`safety.reporting_out`)

- Register as a provider with NCMEC's CyberTipline (an operational and legal
  step, not code).
- Evidence vault: a separate, access-logged, encrypted store, outside the
  normal 90-day deletion, holding only what a report required, kept for the
  period the law requires (one year in the US, per the REPORT Act; confirm
  other regions).
- Report assembler: file, uploader account id, timestamps, and any account
  metadata the lawyer approves. No IP addresses exist, so say so in the policy.
- Region modules: NCMEC (US), National Crime Agency reporting (UK), and the
  EU route (lawyer to confirm: national authorities, Europol, and DSA
  Article 18 style notifications for threats to life, if applicable).
- Handling rules for staff: who may view, wellbeing support, no viewing
  without legal guidance. Decision 5.

**M, mostly operations and legal work.**

### Module 4: Age assurance and minor-safe defaults (`safety.age`)

- Declare an age band at sign-up (`under13` is refused, `13to15`, `16to17`,
  `18plus`). Store the band, the method, and the date. **Never store a birth
  date** or an ID image.
- Under-18 defaults (aligned to the EU guidelines): DM policy "nobody except
  people in a server we share and who accept", no group adds without consent,
  profile private, no presence broadcast, typing indicators off, no streaks
  or push-style engagement, no live stream (the STREAM permission is already
  off for @everyone).
- Adult channels: age-gated; only visible to 18+; disabled where the region
  flag says so.
- Assurance levels as flag configuration: `declared` (default), `estimated`
  (vendor), `verified` (EU age-verification app or a vendor). Different
  regions can require different levels. Decision 6.
- Self-declaration is weak and says so. It is the floor, not the answer.
- **Signals, not scanning.** Likely minors are found through reports,
  moderator flags, contradictory declarations and (later) age estimation or
  store signals. See section 1A for the weights and the review ladder.
- **Built (2026-11-19, uncommitted):** declared age band with expiry, country
  code, account states, age signals with a threshold, declaration limits, the
  stronger-check entry point (`applyVerifiedAge`), automatic band advance, and
  the `underage` report category. **Not built:** the sign-up screen, enforcement
  of `restricted` and `pending_age_review` inside features, the age-check
  vendor, and the teen defaults themselves (Module 5).

**M for declared age and defaults, L for verification vendor or EU app.**

### Module 5: Contact controls and abuse brakes (`safety.contact`)

- User blocking and muting, enforced in the Worker.
- Message requests: first contact from someone you do not share a server with
  arrives as a request, and no conversation key material is delivered until
  accepted (feasible because MLS welcome messages are server-mediated).
- Group-add consent.
- Rate limits on new DMs, new servers, invites, and joins per account.
- Existing `dm_policy` default flips to requests-only for under-18s.

**M.**

### Module 6: Blocklists and platform enforcement (`safety.blocklists`)

- Platform-level suspension of accounts, servers and invite codes, with a
  stored reason and the statement-of-reasons message.
- Blocklists for usernames, server names, descriptions, domains in public
  fields, and file hashes (from Module 2 and from reports).
- Ban evasion handling that does not use IP addresses: device-key and account
  linkage only, with the privacy cost written down.

**M.**

### Module 7: Trusted flaggers and law-enforcement process (`safety.authorities`)

- A published page and mailbox for abuse and for authority requests, with a
  policy: what we hold (metadata, ciphertext, public files, reports, never
  message content or IPs), how requests are verified, preservation requests,
  and emergencies.
- Priority queue for trusted flaggers (formal status in the DSA is for larger
  platforms, so this may be voluntary; lawyer to confirm), including hotlines
  such as IWF or NCMEC partners.
- Staff checklist and a request log.

**S in code, mostly policy and legal.**

### Module 8: Transparency reporting (`safety.transparency`)

- Counters from the safety audit log, with no content: reports received by
  category, median time to act, removals, appeals, authority requests,
  CyberTipline reports filed.
- Publish at least yearly. Whether the formal DSA transparency report is
  required for a small provider is a lawyer question; I believe small and
  micro providers are exempt from the standard report, **Unconfirmed**.
  Publishing anyway also supports the privacy-first brand.

**S.**

### Module 9: Legal and notices layer (`safety.legal`)

Not code-heavy: terms and acceptable use policy, an EU and UK point of contact
and legal representative where required, a published list of subprocessors
(including scanner and age vendors), data protection impact assessment, and a
child-safety page explaining honestly what can and cannot be seen. **Legal M.**

---

## 5. Region flags: switch modules without a release

Goal: turn modules on or tighten settings per region in production with no
deploy.

### Design

- **Table:** D1 `safety_flags` with columns `module`, `region`, `enabled`,
  `config` (JSON, validated by a zod schema in `workers/shared`), `updated_by`,
  `updated_at`. A second table `safety_flag_log` is append-only history.
- **Regions:** `default`, then countries (`US`, `DE`, `GB`), then groups
  (`EU`, `EEA`), then optionally US states (`US-TX`). The most specific match
  wins, with `default` as the fallback. Groups are defined in code or config,
  not hard-coded in each check.
- **Resolution:** at sign-up a user declares a country; the Worker also sees the
  request country from Cloudflare headers. Neither requires storing an IP
  address. Store the *country code* only, on the account, plus the date it was
  last checked. Use the stricter of declared and observed country for safety
  modules, and let a lawyer decide how to handle travel and VPNs.
- **Unknown region:** fails to the strictest minor-safe configuration, not to
  "off". Decision for Nicole whether that blocks sign-up entirely.
- **Delivery:** flags are read in the Worker with a short cache (about 60
  seconds), so a change takes effect within a minute everywhere. The client gets
  its relevant flags (age gate on, adult channels hidden) in the session
  bootstrap and never decides policy; the server enforces everything.
- **Changes:** made only from the internal admin tool behind Cloudflare Access
  with a hardware key, two-person approval for turning a module *off*, and every
  change written to the flag log. A break-glass kill switch for the scanner
  module is needed too (a bad vendor deploy must not take uploads down or, worse,
  fail open).
- **Testing:** every flag has a staging value, and tests in the repo cover each
  module in the on and off states, as the permission function is tested today.

**M, built as part of Module 0.**

### Starting configuration (proposal)

| Module | default | US | EU/EEA | UK |
| --- | --- | --- | --- | --- |
| `safety.reports` | on | on | on | on |
| `safety.public_scan` | on (blocks uploads if off) | on | on | on |
| `safety.reporting_out` | off | NCMEC on | EU route per lawyer | NCA on |
| `safety.age` level | declared | declared, 18+ in alpha | declared, upgrade per lawyer | declared, upgrade per lawyer |
| `safety.contact` | on | on | on, under-18 strict | on, under-18 strict |
| Adult channels | off | off | off | off until verified-18 exists |
| Region open to users | no | yes | no | no |

---

## 6. Phased plan

### Phase 0: before the first invite

Size: **L** engineering, plus a lawyer engagement in parallel.

1. Module 0: flags and safety audit log. (M)
2. Module 1: platform report queue and internal admin tool. (L)
3. Module 5: blocking, message requests, rate limits. (M)
4. Module 4: declared age and minor-safe defaults, alpha limited to 18+ (the
   minimum age is a region flag so it can drop to 13 later). (M)
4a. The build-in-now items from section 1A: terms versioning, account states,
   legal hold, retention as configuration, structured reason codes,
   age-restricted labels, country and age band on the account, hash store,
   staff access log, message-request design. (M, mostly schema and small APIs)
5. Module 6: platform suspension and basic blocklists. (S to M)
6. Public uploads stay off (already a launch gate).
7. Account deletion, to settle the preservation exception.
8. Legal: terms, acceptable use, abuse contact, NCMEC registration started,
   evidence-handling procedure drafted. Update `docs/launch-checklist.md` and
   `docs/threat-model.md` to point here.

#### Phase 0 groundwork status (written 2026-11-19, uncommitted, tests pass)

| Item | State |
| --- | --- |
| Region flags (`safety_flags`, history log, 60 second cache, EU/EEA/US-state/country resolution, validated config per module) | **Built.** No admin screen yet: `setFlag` is a library call for the future staff tool |
| Terms and policy acceptance records and "outstanding" list | **Built.** Sign-up and client screens not built |
| Account states and enforcement of `suspended` and `underage_removed` at sign-in token check | **Built.** `restricted` and `pending_age_review` are stored but features do not yet check them |
| Age band, country, declaration route, signals, review threshold | **Built** (see Module 4). Sign-up flow not wired |
| Legal holds (accounts, servers, files, reports) | **Built.** Report holds are enforced by the retention sweep. Account deletion does not exist yet and **must call `assertNotHeld`** when built. Server deletion and file cleanup do not check holds yet |
| Retention as configuration | **Partly.** The Durable Object reads `MODERATION_RETENTION_DAYS` (default 90). Not per region yet, because a Server object cannot read the region flags |
| Reason codes on moderation actions | **Built** (optional on every action, stored on the audit log). Telling the affected person is not built |
| Age labels on channels | **Built as a label and a gate:** creating or labelling an age restricted channel is refused unless the region flag allows it (default off). Hiding such channels from under-18s is not built |
| Staff access log | **Built** for flag changes, account state changes and holds. Viewing a report or evidence needs the admin tool, which is not built, to call `logStaffAccess` |
| Hash store, message-request design, guardian placeholder, parent deletion route | **Not built** (listed in 1A) |

### Phase 1: alpha launch, US

Size: **M to L**.

1. Module 2: choose a scanner vendor, implement `ImageScanner`, make errors fail
   closed. Then turn public uploads on.
2. Module 3: evidence vault, CyberTipline reporting, drill with a test report.
3. Module 7: authority and trusted flagger process, published page.
4. Module 8: internal counters first; public report later.
5. Tabletop exercise: a reported CSAM item, a threat-to-life report, an
   authority request, a TAKE IT DOWN request.

### Phase 2: open to the EU

Size: **L**, and the lawyer's list below decides the exact scope.

1. Confirm provider status under the DSA, legal representative, contact
   points, terms wording, and which duties apply at this size.
2. Align defaults with the Article 28 guidelines (most already done in Phase 0).
3. Age assurance upgrade: EU age-verification app or a vendor for adult
   channels, if those exist. (L)
4. EU reporting route in Module 3.
5. Data protection impact assessment and privacy page updates.
6. Statement of reasons and appeal flows verified against the DSA text.
7. Turn the EU region flag on for a small, invited group first.

### Phase 3: UK, other regions, ongoing watch

Size: **M**, then continuous.

1. Ofcom illegal-content and children's risk assessments, written and kept.
2. UK NCA reporting in Module 3.
3. Re-check US state laws, KOSA/KIDS Act, and the CSA Regulation each quarter
   (put a calendar item in the roadmap). Flag changes into configuration, not
   releases, wherever possible.

---

## 7. Open questions for a lawyer

Grouped by who should answer. Please do not treat the answers above as settled.

**Scope and entity**

1. Where are we established, and what EU and UK representation, contact-point and
   registration requirements follow from serving users there?
2. Which DSA duties apply at our size (micro or small enterprise status, and the
   12-month transition after growing past it)? Specifically Articles 11 to 18
   and 24 as they apply to us.
3. Are we a "hosting service", an "online platform", or an "interpersonal
   communications service" under EU law, and does that differ for public
   channels versus DMs?

**Scanning and encryption**

4. Is hash-matching *public* uploads lawful under ePrivacy and GDPR without the
   2026/1881 derogation, and what is the lawful basis?
5. Do public text channels count as private communications under ePrivacy?
6. Does a client-side link warning from a locally stored blocklist count as
   scanning or monitoring under any current or proposed rule?
7. If the permanent CSA Regulation passes with risk-mitigation duties, what
   would a E2EE provider need to show? Is there anything to prepare now?
8. UK: does section 121 accredited technology apply to a service of our size,
   and what does the Ofcom position on private messaging mean for us?

**Reporting and evidence**

9. NCMEC registration, who may review reported material, what the report must
   contain, and how to deal with the one-year preservation requirement alongside
   our 90-day retention and the GDPR storage limit.
10. EU and UK equivalents: where do we report, in what form, and are there
    mandatory-reporting obligations for us today?
11. Liability and protections for staff handling reports.
12. Are reports "from the reporter's device" sufficient evidence, and how do we
    handle one user reporting another's messages (privacy of the reported user,
    GDPR rights of access to a report)?

**Children and age**

13. Minimum age: COPPA for under 13, GDPR age of digital consent per Member State
    (13 to 16) and whether it applies given our legal basis, and the UK
    Children's Code. If the terms say 18+ but teenagers use the service anyway,
    do the children's duties still apply, and what age checks would end that?
13c. With an 18+ alpha and children present anyway, what is the standard for
    "knowledge" of a child's age (a user report, a moderator flag, a
    contradictory declaration), what must we do once we have it, and what
    records show we acted reasonably?
13a. Is "age band plus expiry month" enough, or must we hold a birth date for
    any region? Do we need a parent contact route and parental consent for 13
    to 15 in some countries?
13b. Does the EU expectation of parental tools apply to a service whose
    messages parents cannot see, and what is the minimum we should offer?
14. Is declared age sufficient for a general chat service in each region, and what
    triggers a duty to verify (adult channels, minimum age laws in France, Italy,
    certain US states)?
15. Which US state laws apply to a chat service, and which are enjoined as of
    launch?

**Other**

16. TAKE IT DOWN Act: confirm we are a "covered platform" and what we can
    do with E2EE content (nothing) versus public content.
17. Government and law-enforcement requests: what must we disclose, to whom, how
    to verify authority, and gag-order handling.
18. Terms of service and acceptable use language; indemnity for server owners
    who moderate their own communities.
19. Can marketing say "end-to-end encrypted" alongside a child-safety page? The
    launch checklist already restricts this until the outside review passes.

---

## 8. Things I could not confirm

- The claimed "EU URL blocking for adult content regardless of sender and
  recipient". See the summary.
- Whether blocking orders remain in the current CSA Regulation trilogue text.
- Current status of the permanent CSA Regulation after about September 2026, and
  the exact trilogue dates mentioned by some sources.
- Whether DSA hosting-service duties (Articles 13 and 16) apply to micro and
  small providers as I believe.
- Exact age-of-consent rules by EU Member State.
- Current status of the amended COPPA rule and of Utah's and Louisiana's app-store
  laws.
- Detailed UK duties for a small service and the final text of the November 2026
  Ofcom proactive-technology draft.
- Which scanner vendors will accept us as a customer, their terms and costs.
- Details of the technical design and product brief (not available to read).
- Whether a minimum age is written anywhere outside this machine. None is in the
  repo or in the Dreadforged folders I could search.
- Discord's current rules and the exact UK regulator expectations on age checks
  (stated from memory in section 1A, not verified in this pass).

## 9. Follow-up edits to existing docs (not made)

- `docs/launch-checklist.md`: add a safety section that links here; gate the
  alpha on Phase 0.
- `docs/threat-model.md`: replace the "design only" row for illegal content with
  the module list and statuses.
- `docs/privacy-notes.md`: add age band, country code, report and evidence data
  to the "what the server holds" table.
