/**
 * YouTube OAuth2 refresh_token 取得スクリプト
 *
 * 使い方:
 *   1. Google Cloud Console で OAuth 2.0 クライアント ID を作成
 *      - アプリケーションの種類: ウェブアプリケーション
 *      - 承認済みのリダイレクト URI: http://localhost:3456/callback
 *   2. 環境変数を設定:
 *      export YT_CLIENT_ID="your-client-id"
 *      export YT_CLIENT_SECRET="your-client-secret"
 *   3. 実行:
 *      npx tsx scripts/get-youtube-token.ts
 */

import http from "node:http";
import { URL } from "node:url";

const PORT = 3456;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.upload",
].join(" ");

const clientId = process.env.YT_CLIENT_ID;
const clientSecret = process.env.YT_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("ERROR: YT_CLIENT_ID と YT_CLIENT_SECRET を環境変数に設定してください");
  console.error("");
  console.error("  export YT_CLIENT_ID='your-client-id'");
  console.error("  export YT_CLIENT_SECRET='your-client-secret'");
  console.error("  npx tsx scripts/get-youtube-token.ts");
  process.exit(1);
}

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

async function exchangeCode(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId!,
      client_secret: clientSecret!,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h1>認証エラー</h1><p>${error}</p>`);
    server.close();
    process.exit(1);
    return;
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>エラー</h1><p>認可コードが見つかりません</p>");
    return;
  }

  try {
    const tokens = await exchangeCode(code);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<h1>認証成功！</h1><p>このウィンドウを閉じてターミナルを確認してください。</p>"
    );

    console.log("");
    console.log("=== YouTube OAuth トークン取得成功 ===");
    console.log("");
    console.log("以下を .env に追記してください:");
    console.log("");
    console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("");
    console.log(`(参考) access_token: ${tokens.access_token}`);
    console.log(`(参考) expires_in: ${tokens.expires_in}秒`);
    console.log("");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h1>エラー</h1><pre>${err}</pre>`);
    console.error("Token exchange error:", err);
  } finally {
    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 1000);
  }
});

server.listen(PORT, () => {
  console.log("=== YouTube OAuth トークン取得ツール ===");
  console.log("");
  console.log("以下の URL をブラウザで開いて Google 認証を行ってください:");
  console.log("");
  console.log(authUrl.toString());
  console.log("");
  console.log(`コールバック待機中... (http://localhost:${PORT}/callback)`);
});
