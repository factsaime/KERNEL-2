/* Kernel — end-to-end encryption helpers, built on Web Crypto.
 *
 * Everything here runs in the browser. The server only ever sees:
 *   - the auth hash (derived from the password, one-way),
 *   - the public half of the ECDH key pair,
 *   - the private half wrapped with AES-GCM under a key derived from the password,
 *   - message and reaction ciphertext.
 *
 * Web Crypto is unavailable outside a secure context, so the app refuses to run
 * over plain HTTP on a non-localhost host instead of silently sending plaintext.
 */
(function () {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const ITERATIONS = 210000;      // PBKDF2-SHA256 rounds
  const WRAP_IV_BYTES = 12;       // AES-GCM nonce

  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function unb64(text) {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  }

  const available = () =>
    typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.getRandomValues === 'function';

  function randomSalt() {
    return b64(crypto.getRandomValues(new Uint8Array(16)));
  }

  // password -> master key -> auth hash (to the server) + key-encrypting key (stays here)
  async function fromPassword(password, saltB64, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const master = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: unb64(saltB64), iterations: iterations || ITERATIONS, hash: 'SHA-256' },
      base, 256,
    );

    const hkdfKey = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
    const authBits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('kernel-auth-v1') },
      hkdfKey, 256,
    );
    const kekBits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('kernel-kek-v1') },
      hkdfKey, 256,
    );
    const kek = await crypto.subtle.importKey('raw', kekBits, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { authHash: b64(authBits), kek };
  }

  async function newIdentity() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pub = await crypto.subtle.exportKey('raw', pair.publicKey);
    return { pair, pubkey: b64(pub) };
  }

  // Store the private key so a future session can recover it from the password.
  async function wrapPrivate(pair, kek) {
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
    const iv = crypto.getRandomValues(new Uint8Array(WRAP_IV_BYTES));
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, pkcs8);
    return { wrappedPriv: b64(wrapped), wrapIv: b64(iv) };
  }

  async function unwrapPrivate(wrappedB64, ivB64, kek) {
    const pkcs8 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, kek, unb64(wrappedB64));
    return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  }

  // Both sides derive the same AES-GCM key: ECDH shared secret -> HKDF.
  // saltText must be identical for both participants (we pass the two sorted ids).
  async function conversationKey(myPrivate, peerPubB64, saltText) {
    const peer = await crypto.subtle.importKey(
      'raw', unb64(peerPubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, [],
    );
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, myPrivate, 256);
    const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(saltText), info: enc.encode('kernel-conv-v1') },
      hkdfKey, 256,
    );
    return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  async function encryptText(key, text) {
    const iv = crypto.getRandomValues(new Uint8Array(WRAP_IV_BYTES));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
    return { ct: b64(ct), iv: b64(iv) };
  }

  // Returns null when the ciphertext cannot be opened (wrong key, tampered data).
  async function decryptText(key, ctB64, ivB64) {
    if (!key || !ctB64 || !ivB64) return null;
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, unb64(ctB64));
      return dec.decode(pt);
    } catch {
      return null;
    }
  }

  window.KernelCrypto = {
    available, randomSalt, fromPassword, newIdentity, wrapPrivate, unwrapPrivate,
    conversationKey, encryptText, decryptText, b64, unb64, ITERATIONS,
  };
})();
