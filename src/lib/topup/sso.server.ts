import crypto from "node:crypto";

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function getTopupBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_TOPUP_BASE_URL || "https://top-up-automation.vercel.app").replace(/\/$/, "");
}

export function isTopupSsoConfigured(): boolean {
  return Boolean(process.env.TOPUP_SITEA_SSO_SECRET?.trim());
}

/** 簽署 topUpAutomation Site B 店主 SSO JWT（對齊 sitea-jwt-integration-guide）。 */
export function signTopupOwnerSsoToken(params: { shopId: string; shopName: string }) {
  const secret = process.env.TOPUP_SITEA_SSO_SECRET?.trim();
  if (!secret) {
    throw new Error("伺服器尚未設定 TOPUP_SITEA_SSO_SECRET。");
  }

  const shopId = params.shopId.replace(/\D/g, "").slice(0, 8);
  if (!/^\d{8}$/.test(shopId)) {
    throw new Error("shopId 須為 8 位數字。");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: process.env.TOPUP_SITEA_SSO_ISSUER?.trim() || "site-a",
    aud: process.env.TOPUP_SITEA_SSO_AUDIENCE?.trim() || "site-b",
    sub: `owner:${shopId}`,
    jti: crypto.randomUUID(),
    iat: now,
    nbf: now - 60,
    exp: now + 900,
    role: "owner",
    shop: {
      shopId,
      shopName: params.shopName || shopId,
    },
    redirect: {
      path: "/owner.html",
      txId: null,
    },
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function buildTopupOwnerEmbedUrl(params: { shopId: string; shopName: string }) {
  const token = signTopupOwnerSsoToken(params);
  const base = getTopupBaseUrl();
  return `${base}/owner.html?ssoToken=${encodeURIComponent(token)}`;
}
