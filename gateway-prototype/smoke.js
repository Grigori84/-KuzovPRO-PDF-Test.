"use strict";

// Safe Yandex Cloud Functions smoke test: no credentials, no storage access.
// Entrypoint: smoke.handler; runtime: Node.js 22.
module.exports.handler = async function () {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    isBase64Encoded: false,
    body: JSON.stringify({
      project: "KuzovPRO PDF",
      test: "function-ready",
      storage: "not-connected",
      upload: "disabled"
    })
  };
};
