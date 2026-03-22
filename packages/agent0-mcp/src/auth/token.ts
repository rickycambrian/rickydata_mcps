/**
 * Re-exports for auth module.
 */
export {
  getDerivationMessage,
  deriveWalletFromSignature,
  verifyDerivationSignature,
  type DerivedWallet,
} from "./wallet-derivation.js";

export {
  getReadOnlySDK,
  getAuthenticatedSDK,
  setDerivedKey,
  hasAuthentication,
  getCurrentChainId,
  setChainId,
  getAuthStatus,
} from "./sdk-client.js";
