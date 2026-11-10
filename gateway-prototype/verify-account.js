"use strict";

/**
 * Safe IAM attachment diagnostic for the PRIVATE KuzovPRO Cloud Function.
 *
 * This test NEVER logs, returns, forwards, or stores the IAM token.
 * Entry point: verify-account.handler
 * Runtime: Node.js 22.
 */
module.exports.handler = async (_event, context) => {
  const raw = context?.token;
  const hasToken =
    (typeof raw === "string" && raw.length > 20) ||
    (typeof raw === "object" && raw !== null &&
      (typeof raw.access_token === "string" && raw.access_token.length > 20 ||
       typeof raw.iamToken === "string" && raw.iamToken.length > 20));

  return {
    statusCode: hasToken ? 200 : 503,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    isBase64Encoded: false,
    body: JSON.stringify({
      project: "KuzovPRO",
      service_account_token_available: Boolean(hasToken),
      upload: "disabled",
      note: "No token values are returned or logged"
    })
  };
};
