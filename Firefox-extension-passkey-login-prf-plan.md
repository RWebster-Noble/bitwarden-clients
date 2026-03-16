# Firefox Extension Passkey Login with PRF — Implementation Design Document

## Overview

This document describes how to implement full passwordless passkey (WebAuthn/FIDO2) login
with PRF-based vault decryption for the Bitwarden **Firefox** browser extension.

Currently, passkey login (`login-with-passkey`) is restricted to Chromium-based browsers only
(`isLoginWithPasskeySupported()` returns `false` for Firefox). The root cause is that Firefox
does not allow a browser extension to call `navigator.credentials.get()` with a custom
relying-party ID — the RP ID must match the extension's own origin, not `bitwarden.com`.

The solution mirrors the **existing WebAuthn 2FA fallback** mechanism: the extension cannot
call the WebAuthn API directly, so it opens a connector page hosted on the web vault domain
which handles the _entire_ WebAuthn ceremony, then relays the result back to the extension via
the content-script message bridge, and the extension completes the login using those
externally-obtained credentials.

---

## Background: How the Existing WebAuthn 2FA Fallback Works

Understanding the 2FA mechanism is essential because this feature is a direct extension of it.

```
Extension popup (2FA route)
  │  WebAuthnIFrame.init(providerData)
  │  → platformUtilsService.launchUri(webVaultUrl/webauthn-fallback-connector.html?data=...)
  ↓
Web vault connector page (webauthn-fallback.ts)
  │  navigator.credentials.get({ publicKey: challenge })
  │  window.postMessage({ command:"webAuthnResult", data, remember }, "*")
  ↓
Content script (content-message-handler.ts) — injected into all web pages
  │  chrome.runtime.sendMessage({ command:"webAuthnResult", data, remember, referrer })
  ↓
Extension background (runtime.background.ts)
  │  isValidVaultReferrer(referrer) → validate hostname
  │  openTwoFactorAuthWebAuthnPopout({ data, remember })
  ↓
Extension popup (2fa;webAuthnResponse=<data>)
  │  TwoFactorAuthWebAuthnComponent reads route param
  │  → loginStrategyService.logInTwoFactor(token)
```

Key points:

- The web vault connector is a **plain TypeScript/HTML page**, not an Angular app.
- The connector receives the WebAuthn challenge as a URL parameter (pre-fetched by the
  extension, because the 2FA challenge comes from already having logged in with a password).
- The content script acts as a **one-way bridge** from web page → extension background.
- The background validates the message **origin/referrer** against a list of known vault hostnames.
- The extension background opens a **popout** at a specific extension route to finish the flow.

---

## What Is Different for Full Passkey Login (vs 2FA)

The 2FA flow only relays a simple token string, and the extension pre-fetches the challenge
because the user is already partially authenticated (past the password step). Passkey login
is fundamentally different:

| Aspect                                  | 2FA WebAuthn                                       | Full Passkey Login                                           |
| --------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| When it runs                            | After email+password login                         | _Instead_ of password — user is **not** authenticated at all |
| Challenge source                        | Extension already has it (from 2FA providers data) | Must be fetched from the server — but by **who**?            |
| Who calls `credentials.get()`           | Web vault connector page                           | Web vault connector page                                     |
| What must be relayed back               | A token string                                     | Credential assertion JSON + `token` + **PRF output bytes**   |
| What the extension does with the result | `logInTwoFactor(token)`                            | `logIn(WebAuthnLoginCredentials)`                            |
| PRF key derivation                      | Not required                                       | Required (enables passwordless vault decryption)             |

### The Key Insight: The Assertion Options Endpoint is Unauthenticated

For the 2FA flow, the extension can pre-fetch the challenge because it is already
partially authenticated. For passkey login, the user hasn't authenticated at all yet —
so how does the extension get the challenge?

The answer is: **it doesn't need to**. The `/webauthn/assertion-options` endpoint is
**unauthenticated**. It simply returns a server-generated challenge token. The challenge is
the server's anti-replay mechanism, not an authentication check. Authentication only happens
when the client submits the credential assertion response _signed by the user's private key_.

This means the **web vault connector page can fetch the assertion options itself** — no
prior extension API call is needed. The extension's only job at the start is to open the
web vault connector tab.

Furthermore, the `token` returned by `/webauthn/assertion-options` is a **stateless bearer
token** (not bound to any HTTP session). The identity server validates it cryptographically
when the assertion is submitted — it doesn't check whether the token was fetched from the
same session that submits the login. So the extension can receive the `token` from the web
vault tab and submit it to the identity server from its own HTTP context.

> **⚠️ Important**: This stateless-token assumption should be verified against the
> server-side implementation before shipping. If the token IS session-bound, a different
> approach is needed (e.g. involving the server team to add a session-independent token flow).

---

## Architecture: Web-Vault-Initiated Relay

The corrected architecture is:

1. **User clicks "Log in with passkey"** in the Firefox extension popup.
2. **Extension immediately opens the web vault connector tab** (no prior API call) — passing
   only its ECDH ephemeral public key in the URL.
3. **Connector page handles the entire WebAuthn ceremony**:
   a. Fetches assertion options from the server (`GET /webauthn/assertion-options`)
   b. Calls `navigator.credentials.get()` with PRF extension
   c. Obtains the assertion response AND the raw PRF output bytes
4. **Connector encrypts the PRF bytes** using the extension's ECDH public key.
5. **Connector posts a `window.postMessage`** with `{ token, assertionData, encryptedPrfOutput }`.
6. **Content script bridges** the message to the extension background.
7. **Extension background** validates the referrer, decrypts the PRF bytes, stores the result
   in memory, and opens a result popout.
8. **Result popout** derives the PRF key, calls `logIn()`, and completes the authentication.

---

## ⚠️ Security Concerns

### 1. PRF Output Is a Vault Decryption Key — It Must Not Leak

The raw PRF output is the cryptographic material used to derive the key that decrypts the
user's vault. It is functionally equivalent to the user's master password in terms of
sensitivity.

**Concern**: The PRF output must travel from the connector page, through `window.postMessage`,
through the content script, to the extension background. Each step crosses a trust boundary.

**Mitigations**:

- The content script validates `event.source === window` and `EventSecurity.isEventTrusted(event)`.
- The background validates `isValidVaultReferrer(referrer)` — the referrer is extracted from
  `event.origin` by the content script, NOT from the message payload (prevents spoofing).
- The PRF bytes must be **ECDH-encrypted** before transmission (see Security Concern #2).
- The PRF bytes must NEVER be logged, written to storage, or included in URLs.
- They must be consumed and zeroed in memory as soon as `createSymmetricKeyFromPrf()` completes.

### 2. Encrypting the PRF Output in Transit: ECDH Key Exchange

The existing 2FA flow uses `window.postMessage(data, "*")` — any origin could intercept it.
For a 2FA token (just a string), this risk is acceptable. For PRF output (equivalent to a
master password), it is not.

**Solution**: Ephemeral ECDH key exchange.

Before opening the connector tab, the extension background generates an **ephemeral ECDH key pair**.
The public key is encoded into the connector page URL (it is not secret). The connector page:

1. Generates its own ephemeral ECDH key pair.
2. Computes `sharedSecret = ECDH(connectorPrivateKey, extensionPublicKey)`.
3. Derives an AES-GCM encryption key from the shared secret (via HKDF or direct use).
4. Encrypts the raw PRF bytes under this key.
5. Includes in the `postMessage`: the encrypted ciphertext, the AES-GCM IV, and the
   connector's ephemeral public key (so the extension can compute the same shared secret).

The extension background:

1. Computes `sharedSecret = ECDH(extensionPrivateKey, connectorPublicKey)`.
2. Decrypts the PRF bytes.
3. Immediately clears the private key from memory.

**Why this helps**: Even if another script on the vault page intercepts the `postMessage`,
it cannot recover the PRF bytes without the extension's private key, which is never exposed
and discarded immediately after use. The ECDH key pair is single-use and ephemeral.

### 3. Referrer Validation — the Primary Trust Gate

The background's `isValidVaultReferrer()` check is the main security control for all message
relay flows. It validates that the message came from a page on a known vault hostname.

**Concern**: A malicious page that knows the extension ID could try to submit a fake
`passkeyLoginResult` message.

**Mitigation**: The referrer is extracted from `event.origin` by the content script (which
validates `event.source === window`). A page cannot fake its own origin. The background
validates the referrer hostname against a list of known vault URLs. If the user has a
self-hosted instance, only the configured vault URL is accepted.

### 4. Session Expiry on Pending Relay State

The extension stores an ephemeral ECDH private key while waiting for the connector page result.

**Mitigation**: Set a 5-minute timeout on the pending state (matching the existing login
strategy session timeout). If no result arrives, discard the ECDH key pair and show an error.

### 5. PRF Buffer Zeroing

Once the PRF bytes are used to derive the vault key, the raw bytes should be zeroed.

**Mitigation**: After `createSymmetricKeyFromPrf(prfOutput)` returns, call
`new Uint8Array(prfOutput).fill(0)`. TypeScript/V8 cannot guarantee immediate garbage
collection, but removing the reference and zeroing the buffer is the best available option
without WASM.

### 6. Token Statefulness (Open Question)

As noted above, the design assumes the `token` from `/webauthn/assertion-options` is
stateless. If it is session-bound, the extension cannot use a token obtained by the web vault
tab in its own login request. This must be verified before implementing.

### 7. Connector Tab Lifetime

The connector tab remains open after posting the result. It should be closed programmatically.

**Mitigation**: The extension background calls `chrome.tabs.remove(tabId)` after receiving
and validating the `passkeyLoginResult` message.

---

## Detailed Implementation Plan

### Change 1: New Web Vault Connector Page

**File (new)**: `apps/web/src/connectors/passkey-login-connector.ts`
**Template (new)**: `apps/web/src/connectors/passkey-login-connector.html`

**Why**: Unlike the 2FA fallback which receives a pre-fetched challenge, this connector page
must handle the **entire WebAuthn ceremony from scratch**: fetch assertion options, call
`credentials.get()` with PRF, and relay the result. It cannot reuse `webauthn-fallback-connector`
because that page only handles a pre-baked challenge and posts back only a token string (no
server token relay, no PRF).

**URL parameters received**:

- `extensionPublicKey`: base64url-encoded ephemeral ECDH public key from the extension
  background (used to encrypt PRF output).
- No assertion challenge is passed — the connector fetches it itself.

**What this page must do**:

```typescript
// 1. Parse URL parameters
const extensionPublicKeyB64 = getQsParam("extensionPublicKey");

// 2. Fetch assertion options from the server (unauthenticated endpoint)
const response = await fetch(`${apiOrigin}/webauthn/assertion-options`, { method: "POST" });
const { options, token } = await response.json();

// 3. Compute the PRF salt (must match what the extension uses for key derivation)
//    This is derived the same way as WebAuthnLoginPrfKeyService.getLoginWithPrfSalt()
//    — a fixed well-known salt or a salt the extension encodes in the URL.
const prfSalt = derivePrfSalt(); // or decode from URL param

// 4. Call credentials.get() with PRF extension
const credential = await navigator.credentials.get({
  publicKey: {
    ...parseAssertionOptions(options),
    extensions: {
      prf: { eval: { first: prfSalt } },
    },
  },
});

// 5. Extract PRF output (raw bytes)
const prfOutput = credential.getClientExtensionResults()?.prf?.results?.first ?? null;

// 6. Serialize the assertion (without PRF — PRF must not go to the server)
const assertionData = buildDataString(credential); // reuse common-webauthn.ts helper

// 7. Encrypt the PRF output with the extension's ECDH public key
let encryptedPrfOutput = null;
let connectorPublicKeyB64 = null;
if (prfOutput && extensionPublicKeyB64) {
  const { ciphertext, iv, connectorPublicKey } = await encryptPrfWithEcdh(
    prfOutput,
    extensionPublicKeyB64,
  );
  encryptedPrfOutput = { ciphertext, iv };
  connectorPublicKeyB64 = connectorPublicKey;
}

// 8. Post result back to extension via content script
window.postMessage(
  {
    command: "passkeyLoginResult",
    token, // server's challenge token (stateless)
    assertionData, // JSON credential assertion (no PRF)
    encryptedPrfOutput, // { ciphertext: base64, iv: base64 } | null
    connectorPublicKey: connectorPublicKeyB64, // extension uses this to decrypt
  },
  "*",
);
```

The PRF salt question: `WebAuthnLoginPrfKeyService.getLoginWithPrfSalt()` returns a fixed
well-known salt that is used consistently. Either:

- The extension encodes it as a URL parameter (since it is not secret — it's a public salt), OR
- The connector page uses the same fixed value independently.
  The second option is simpler and avoids adding more URL state.

**Webpack config change**: Register `passkey-login-connector` as a new entry point in
`apps/web/webpack.base.js` (same pattern as `webauthn-fallback-connector`).

---

### Change 2: Extension Background — Ephemeral ECDH and Message Handler

**File (modify)**: `apps/browser/src/background/runtime.background.ts`

**Why**: The background must:

1. Generate an ephemeral ECDH key pair before opening the connector tab
2. Receive the `passkeyLoginResult` message and decrypt the PRF bytes using the private key

**Add to `RuntimeBackground`**:

```typescript
private pendingPasskeyLoginEcdhSession: {
  privateKey: CryptoKey;   // ECDH private key — discarded after use
  expiresAt: number;       // Date.now() + 5 minutes
} | null = null;
```

**New handler in `processMessage()`**:

```typescript
case "passkeyLoginResult": {
  if (!(await this.isValidVaultReferrer(msg.referrer))) {
    return;
  }
  await this.handlePasskeyLoginResult(msg);
  break;
}
```

**New method `handlePasskeyLoginResult()`**:

1. Check `pendingPasskeyLoginEcdhSession` is set and not expired.
2. If `encryptedPrfOutput` is present and `connectorPublicKey` is present:
   - Compute ECDH shared secret using stored private key and connector's public key.
   - AES-GCM-decrypt the PRF bytes.
3. Store `{ token, assertionData, prfOutput }` in `PasskeyLoginRelayService` (in memory).
4. Clear `pendingPasskeyLoginEcdhSession` (private key discarded).
5. Close the connector tab (`chrome.tabs.remove(tabId)`) — the background can look up the
   sender tab from the message sender.
6. Call `openPasskeyLoginResultPopout()`.

**New method `initiatePasskeyLoginRelay()`** (called when user navigates to
`/login-with-passkey` on Firefox):

1. Generate ephemeral ECDH key pair via Web Crypto.
2. Store private key in `pendingPasskeyLoginEcdhSession` with 5-minute expiry.
3. Return the base64url-encoded public key to the caller.

---

### Change 3: New Service — `PasskeyLoginRelayService`

**File (new)**: `apps/browser/src/auth/services/passkey-login-relay.service.ts`

**Why**: The background receives the relay result but the popout needs to consume it. These
are separate browser contexts. A dedicated service holds the in-memory bridge state.

**Interface**:

```typescript
abstract class PasskeyLoginRelayService {
  /** Stores decrypted relay result in memory (called from background after decryption). */
  abstract storeResult(result: {
    token: string;
    assertionData: string;
    prfOutput: ArrayBuffer | null;
  }): void;

  /** Retrieves and clears the relay result (called once from the result popout). */
  abstract consumeResult(): {
    token: string;
    assertionData: string;
    prfOutput: ArrayBuffer | null;
  } | null;
}
```

The implementation is a simple singleton holding the state in the background service worker
memory. `consumeResult()` clears the stored data after returning it (single-use).

---

### Change 4: Content Script — New Message Handler

**File (modify)**: `apps/browser/src/autofill/content/content-message-handler.ts`
**File (modify)**: `apps/browser/src/autofill/content/abstractions/content-message-handler.ts`

**Why**: The content script is the bridge between the connector page's `window.postMessage`
and the extension background's `chrome.runtime.sendMessage`. Analogous to the existing
`webAuthnResult` handler for 2FA.

**Add to `windowMessageHandlers`**:

```typescript
passkeyLoginResult: ({ data, referrer }) =>
  handlePasskeyLoginResultMessage(data, referrer),
```

**New function**:

```typescript
function handlePasskeyLoginResultMessage(data: ContentMessageWindowData, referrer: string) {
  sendExtensionRuntimeMessage({
    command: "passkeyLoginResult",
    token: data.token,
    assertionData: data.assertionData,
    encryptedPrfOutput: data.encryptedPrfOutput,
    connectorPublicKey: data.connectorPublicKey,
    referrer, // extracted from event.origin — cannot be spoofed by page content
  });
}
```

**Why referrer security matters**: The `referrer` is extracted from `event.origin` by
`handleWindowMessageEvent()`, NOT from `data` (the message payload). A page cannot fake
`event.origin`. This is the primary defense against a malicious page impersonating the vault.

---

### Change 5: Extension Popup — New Route and Component

**File (new)**: `apps/browser/src/auth/popup/login-with-passkey-result/login-with-passkey-result.component.ts`
**Route (modify)**: `apps/browser/src/popup/app-routing.module.ts`

**Why**: After the background receives and decrypts the relay result, it opens a new popout
at a dedicated route. This component:

1. Reads the pending result from `PasskeyLoginRelayService.consumeResult()`.
2. If no result (timeout), shows error and redirects to `/login`.
3. Deserializes `assertionData` into a `WebAuthnLoginAssertionResponseRequest`.
4. If `prfOutput` is present: calls `webAuthnLoginPrfKeyService.createSymmetricKeyFromPrf(prfOutput)`, then zeros the buffer.
5. Constructs `new WebAuthnLoginCredentialAssertionView(token, deviceResponse, prfKey)`.
6. Calls `webAuthnLoginService.logIn(assertion)` → POST to identity server.
7. Handles `AuthResult` with the same post-login routing as `LoginViaWebAuthnComponent`.

**Route addition**:

```typescript
{
  path: "login-with-passkey-result",
  component: ExtensionAnonLayoutWrapperComponent,
  children: [{ path: "", component: LoginWithPasskeyResultComponent }],
  data: {
    pageIcon: TwoFactorAuthSecurityKeyIcon,
    pageTitle: { key: "loggingIn" },
    elevation: 1,
  }
}
```

---

### Change 6: Extension Auth Popout Helpers

**File (modify)**: `apps/browser/src/auth/popup/utils/auth-popout-window.ts`

**Why**: The background needs to open the result popout. Follows existing pattern.

**Add**:

```typescript
const AuthPopoutType = {
  // ... existing entries ...
  passkeyLoginResult: "auth_passkeyLoginResult",
} as const;

async function openPasskeyLoginResultPopout() {
  await BrowserPopupUtils.openPopout("popup/index.html#/login-with-passkey-result", {
    singleActionKey: AuthPopoutType.passkeyLoginResult,
  });
}

async function closePasskeyLoginResultPopout() {
  await BrowserPopupUtils.closeSingleActionPopout(AuthPopoutType.passkeyLoginResult);
}
```

---

### Change 7: `WebAuthnLoginService` — New Method for External Assertion

**File (modify)**: `libs/common/src/auth/services/webauthn-login/webauthn-login.service.ts`
**File (modify)**: `libs/common/src/auth/abstractions/webauthn/webauthn-login.service.abstraction.ts`

**Why**: The existing `logIn()` method takes a `WebAuthnLoginCredentialAssertionView`, which
is produced by `assertCredential()` (which calls `navigator.credentials.get()` internally).
For the relay flow, the assertion was performed externally — we have the raw components
(`token`, `deviceResponse` JSON, `prfOutput` bytes). We need a method that accepts these
directly without calling WebAuthn APIs.

**New method**:

```typescript
abstract logInWithExternalAssertion(
  token: string,
  assertionResponseJson: string,  // serialized by buildDataString() on the connector page
  prfOutput: ArrayBuffer | null,
): Promise<AuthResult>;

// Implementation:
async logInWithExternalAssertion(token, assertionResponseJson, prfOutput) {
  const parsed = JSON.parse(assertionResponseJson);
  const deviceResponse = Object.assign(
    Object.create(WebAuthnLoginAssertionResponseRequest.prototype),
    parsed,
  );

  let prfKey: PrfKey | undefined;
  if (prfOutput != null) {
    prfKey = await this.webAuthnLoginPrfKeyService.createSymmetricKeyFromPrf(prfOutput);
    new Uint8Array(prfOutput).fill(0);  // zero raw bytes immediately
  }

  const credential = new WebAuthnLoginCredentials(token, deviceResponse, prfKey);
  return this.loginStrategyService.logIn(credential);
}
```

---

### Change 8: `LoginViaWebAuthnComponent` — Firefox Path

**File (modify)**: `libs/angular/src/auth/login-via-webauthn/login-via-webauthn.component.ts`

**Why**: On Firefox in the extension, `assertCredential()` fails (can't call `credentials.get()`
with the right RP ID). The component needs to detect this and instead open the web vault
connector tab, then show a "waiting" state.

**Approach**: Inject a new `LoginViaWebAuthnComponentService` abstraction (same pattern as
the existing `TwoFactorAuthWebAuthnComponentService`).

**New abstraction** (new file):
`libs/auth/src/angular/login-via-webauthn/login-via-webauthn-component.service.ts`

```typescript
export abstract class LoginViaWebAuthnComponentService {
  /** True when credentials.get() cannot be called here and must be relayed via web vault. */
  abstract shouldUseWebVaultRelay(): boolean;
  /** Opens the web vault connector tab. Returns when the tab has been launched. */
  abstract openWebVaultRelayTab(): Promise<void>;
}

export class DefaultLoginViaWebAuthnComponentService implements LoginViaWebAuthnComponentService {
  shouldUseWebVaultRelay(): boolean {
    return false;
  }
  async openWebVaultRelayTab(): Promise<void> {
    throw new Error("Not supported.");
  }
}
```

**Browser extension implementation** (new file):
`apps/browser/src/auth/services/extension-login-via-webauthn-component.service.ts`

```typescript
export class ExtensionLoginViaWebAuthnComponentService implements LoginViaWebAuthnComponentService {
  shouldUseWebVaultRelay(): boolean {
    return this.platformUtilsService.isFirefox();
  }

  async openWebVaultRelayTab(): Promise<void> {
    // 1. Ask the background to generate the ephemeral ECDH key pair
    const extensionPublicKey = await this.messagingService.sendWithResponse(
      "initiatePasskeyLoginRelay",
    );
    // 2. Open the connector page — it handles everything from here
    const env = await firstValueFrom(this.environmentService.environment$);
    const params = new URLSearchParams({ extensionPublicKey });
    this.platformUtilsService.launchUri(
      `${env.getWebVaultUrl()}/passkey-login-connector.html?${params}`,
    );
  }
}
```

**Modified `authenticate()` in `LoginViaWebAuthnComponent`**:

```typescript
private async authenticate() {
  if (this.loginViaWebAuthnComponentService.shouldUseWebVaultRelay()) {
    // Firefox path: hand off to the web vault connector page.
    // The result comes back asynchronously via the background message handler,
    // which will open the /login-with-passkey-result popout to complete login.
    await this.loginViaWebAuthnComponentService.openWebVaultRelayTab();
    this.currentState = "waiting";  // show "waiting for security key..." UI
    // The current popup window will be replaced by the result popout when done.
    return;
  }

  // Chromium path: unchanged — call credentials.get() directly.
  let assertion: WebAuthnLoginCredentialAssertionView;
  try {
    const options = await this.webAuthnLoginService.getCredentialAssertionOptions();
    assertion = await this.webAuthnLoginService.assertCredential(options);
  } catch (error) { ... }
  // ... rest of existing flow
}
```

---

### Change 9: Extension Login Component Service — Enable for Firefox

**File (modify)**: `apps/browser/src/auth/popup/login/extension-login-component.service.ts`

**Why**: Currently `isLoginWithPasskeySupported()` returns `false` for Firefox, hiding the
"Log in with passkey" button. Once the relay mechanism is in place, Firefox must show it.

```typescript
isLoginWithPasskeySupported(): boolean {
  // Firefox is now supported via the web vault relay mechanism.
  // Safari remains unsupported (different restrictions, no passkey support in extension context).
  return this.platformUtilsService.isChromium() || this.platformUtilsService.isFirefox();
}
```

---

### Change 10: Webpack Configuration — Register New Connector Page

**File (modify)**: `apps/web/webpack.base.js`

**Why**: Connector pages are built as separate webpack entry points.

**Add to entry points**:

```javascript
"passkey-login-connector": "./src/connectors/passkey-login-connector.ts",
```

Add a corresponding `HtmlWebpackPlugin` entry pointing to `src/connectors/passkey-login-connector.html`.

---

### Change 11: Content Security Policy Review

**File (review)**: `apps/browser/src/manifest.json` and `apps/browser/src/manifest.v3.json`

**Why**: The extension's CSP and permissions must allow messaging from the vault domain.
The existing CSP already covers this for 2FA and SSO flows. Verify:

- `connect-src` allows `https://` to the vault domain (for the identity/API calls from the popout)
- `externally_connectable` (if present) allows the vault domain
- No new permissions are needed — the connector tab is a regular web page, not extension content

---

### Change 12: Tests

All new files require unit tests. All modified files require updated tests.

**New test files**:

- `apps/browser/src/auth/services/passkey-login-relay.service.spec.ts`
- `apps/browser/src/auth/popup/login-with-passkey-result/login-with-passkey-result.component.spec.ts`
- `apps/browser/src/auth/services/extension-login-via-webauthn-component.service.spec.ts`

**Modified test files**:

- `apps/browser/src/autofill/content/content-message-handler.spec.ts` — add `passkeyLoginResult`
- `apps/browser/src/background/runtime.background.ts` — add `passkeyLoginResult` handler tests
- `libs/common/src/auth/services/webauthn-login/webauthn-login.service.spec.ts` — add `logInWithExternalAssertion`

---

## Full Corrected Data Flow Diagram

```
Firefox Extension Popup
(/login-with-passkey route — LoginViaWebAuthnComponent)
  │
  │  1. shouldUseWebVaultRelay() → true (Firefox)
  │
  │  2. initiatePasskeyLoginRelay (message to background)
  │     → Background generates ephemeral ECDH key pair
  │     → Stores ECDH private key with 5-min expiry
  │     ← extensionPublicKey (base64url)
  │
  │  3. platformUtilsService.launchUri(
  │       vault.bitwarden.com/passkey-login-connector.html
  │       ?extensionPublicKey=<base64url>
  │     )
  │
  │  currentState = "waiting" (shows loading UI)
  │
  ↓
Browser opens new tab: vault.bitwarden.com/passkey-login-connector.html
  │
  │  4. Parse URL params → extensionPublicKey
  │
  │  5. POST /webauthn/assertion-options  ← UNAUTHENTICATED
  │     ← { options: { challenge, allowCredentials, ... }, token: "server-token" }
  │
  │  6. navigator.credentials.get({
  │       publicKey: { ...options, extensions: { prf: { eval: { first: prfSalt } } } }
  │     })
  │     [Browser shows WebAuthn dialog — user touches key / uses biometrics]
  │
  │  7. assertedCredential returned by browser
  │  8. assertionData = buildDataString(assertedCredential)
  │     (JSON of: id, rawId, type, response.{authenticatorData, clientDataJson, sig})
  │
  │  9. prfOutputRaw = assertedCredential.getClientExtensionResults()?.prf?.results?.first
  │     (32-byte ArrayBuffer — the vault decryption key material)
  │
  │  10. Generate connector ephemeral ECDH key pair (P-256 or X25519)
  │  11. sharedSecret = ECDH(connectorPrivKey, extensionPubKey)
  │  12. encryptionKey = HKDF(sharedSecret)  [or use directly as AES-GCM key]
  │  13. { ciphertext, iv } = AES-GCM-encrypt(prfOutputRaw, encryptionKey)
  │  14. connectorPublicKey = base64url(connectorEphemeralPublicKey)
  │
  │  15. window.postMessage({
  │        command: "passkeyLoginResult",
  │        token: "server-token",          ← stateless, can be used by extension
  │        assertionData: "<json>",         ← credential assertion (no PRF!)
  │        encryptedPrfOutput: { ciphertext, iv },
  │        connectorPublicKey: "<base64url>",
  │      }, "*")
  │
  ↓
Content Script (content-message-handler.ts — injected into vault page)
  │
  │  16. handleWindowMessageEvent(event)
  │       event.source === window ✓
  │       EventSecurity.isEventTrusted(event) ✓
  │       referrer = new URL(event.origin).hostname  → "vault.bitwarden.com"
  │       (referrer from event.origin — cannot be spoofed by message payload)
  │
  │  17. chrome.runtime.sendMessage({
  │        command: "passkeyLoginResult",
  │        token, assertionData, encryptedPrfOutput, connectorPublicKey,
  │        referrer: "vault.bitwarden.com",
  │      })
  │
  ↓
Extension Background (runtime.background.ts)
  │
  │  18. isValidVaultReferrer("vault.bitwarden.com") → true ✓
  │  19. pendingPasskeyLoginEcdhSession exists and not expired? ✓
  │
  │  20. sharedSecret = ECDH(extensionPrivKey, connectorPublicKey)
  │  21. prfOutputRaw = AES-GCM-decrypt(ciphertext, sharedSecret, iv)
  │  22. Clear extensionPrivKey from memory (ephemeral — discard immediately)
  │
  │  23. PasskeyLoginRelayService.storeResult({ token, assertionData, prfOutputRaw })
  │  24. chrome.tabs.remove(senderTab.id)  ← close connector tab
  │  25. openPasskeyLoginResultPopout()
  │
  ↓
New Extension Popout (/login-with-passkey-result route)
  │
  │  26. PasskeyLoginRelayService.consumeResult()
  │       ← { token, assertionData, prfOutputRaw }
  │
  │  27. deviceResponse = deserialize(assertionData)
  │      (WebAuthnLoginAssertionResponseRequest.fromJSON)
  │
  │  28. prfKey = webAuthnLoginPrfKeyService.createSymmetricKeyFromPrf(prfOutputRaw)
  │  29. new Uint8Array(prfOutputRaw).fill(0)  ← zero raw PRF bytes
  │
  │  30. assertion = new WebAuthnLoginCredentialAssertionView(token, deviceResponse, prfKey)
  │
  │  31. webAuthnLoginService.logInWithExternalAssertion(assertion)
  │       → POST /identity/connect/token
  │           grant_type=webauthn
  │           token=<server-token>
  │           deviceResponse=<assertionData>
  │       ← AuthResult { userId, requiresTwoFactor: false }
  │
  │  32. loginSuccessHandlerService.run(userId)
  │  33. Navigate to vault
  │
  ↓
User is logged in with vault decrypted via PRF key ✓
```

---

## Summary of Files Changed

| File                                                                                           | New/Modify | Why                                                                                           |
| ---------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `apps/web/src/connectors/passkey-login-connector.ts`                                           | **New**    | Connector page: fetches assertion options, calls `credentials.get()` with PRF, relays result  |
| `apps/web/src/connectors/passkey-login-connector.html`                                         | **New**    | HTML template for connector page                                                              |
| `apps/web/webpack.base.js`                                                                     | Modify     | Register new connector page as webpack entry point                                            |
| `apps/browser/src/autofill/content/content-message-handler.ts`                                 | Modify     | Handle `passkeyLoginResult` window message                                                    |
| `apps/browser/src/autofill/content/abstractions/content-message-handler.ts`                    | Modify     | Type definition for `passkeyLoginResult`                                                      |
| `apps/browser/src/background/runtime.background.ts`                                            | Modify     | Handle `passkeyLoginResult`; ECDH decrypt PRF bytes; close connector tab; open result popout  |
| `apps/browser/src/auth/services/passkey-login-relay.service.ts`                                | **New**    | In-memory relay of `{ token, assertionData, prfOutput }` between background and result popout |
| `apps/browser/src/auth/popup/utils/auth-popout-window.ts`                                      | Modify     | Add `openPasskeyLoginResultPopout()` and `closePasskeyLoginResultPopout()`                    |
| `apps/browser/src/auth/popup/login-with-passkey-result/login-with-passkey-result.component.ts` | **New**    | Popout: derives PRF key, calls `logInWithExternalAssertion()`, navigates to vault             |
| `apps/browser/src/popup/app-routing.module.ts`                                                 | Modify     | Add `/login-with-passkey-result` route                                                        |
| `apps/browser/src/auth/popup/login/extension-login-component.service.ts`                       | Modify     | Enable passkey login for Firefox                                                              |
| `apps/browser/src/auth/services/extension-login-via-webauthn-component.service.ts`             | **New**    | Firefox: opens connector tab instead of calling `credentials.get()` directly                  |
| `libs/angular/src/auth/login-via-webauthn/login-via-webauthn.component.ts`                     | Modify     | Detect Firefox relay path; show "waiting" UI instead of trying `credentials.get()`            |
| `libs/auth/src/angular/login-via-webauthn/login-via-webauthn-component.service.ts`             | **New**    | Abstraction: `shouldUseWebVaultRelay()` / `openWebVaultRelayTab()`                            |
| `libs/common/src/auth/services/webauthn-login/webauthn-login.service.ts`                       | Modify     | Add `logInWithExternalAssertion()` for relay-obtained credentials                             |
| `libs/common/src/auth/abstractions/webauthn/webauthn-login.service.abstraction.ts`             | Modify     | Declare `logInWithExternalAssertion()` abstract method                                        |
| `apps/browser/src/manifest.json` / `manifest.v3.json`                                          | Review     | Confirm CSP covers vault domain messaging (likely already OK)                                 |

---

## Phased Delivery Recommendation

### Phase 1 (MVP — Passkey auth only, no PRF)

Implement the relay architecture but skip PRF entirely. The user can authenticate with a
passkey on Firefox but will still need their master password to decrypt the vault after login
(standard password-based decryption). This validates the connector-page relay mechanism
without the ECDH encryption complexity.

**Scope reduction for Phase 1**:

- Steps 10–14 in the connector (ECDH + encryption) are omitted
- Steps 20–22 in the background (ECDH + decryption) are omitted
- `prfOutput` is always `null`; `prfKey` is always `undefined` in `logInWithExternalAssertion()`
- No `extensionPublicKey` URL parameter needed

### Phase 2 (Full PRF support)

Add the ECDH key exchange and PRF encryption/decryption. This enables fully passwordless
vault decryption on Firefox — equivalent to what Chromium users already have.

---

## Open Questions / Risks

1. **Token statefulness** _(critical)_: Must verify the `token` from `/webauthn/assertion-options`
   is not HTTP-session-bound before shipping. If it is, the relay approach cannot work as
   described and the server team must be consulted.

2. **Firefox RP ID matching on the connector page**: The connector page at `vault.bitwarden.com`
   must match the RP ID of the registered passkeys. If credentials were registered with
   `rpId: "bitwarden.com"`, this should work since `vault.bitwarden.com` is a subdomain.
   Must be tested with an actual registered passkey on Firefox.

3. **PRF extension support in Firefox**: Firefox added PRF support in Firefox 119. Users on
   older versions get Phase 1 behavior (auth only, no vault decryption). The connector page
   must handle absent PRF output gracefully.

4. **Multiple concurrent attempts**: Rapid clicks could open multiple connector tabs.
   The relay service should track and cancel any existing pending session before starting a new one.

5. **Self-hosted instances**: The connector page URL must use the user's configured vault URL,
   not a hardcoded `vault.bitwarden.com`. The extension encodes the web vault URL as a URL
   parameter, OR the connector page reads it from the API base URL already configured in the
   extension environment (which is what the existing 2FA fallback does via `webVaultUrl`).
