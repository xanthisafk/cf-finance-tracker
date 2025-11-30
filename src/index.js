/**
 * CLOUDFLARE WORKER: Finance Tracker PWA (Rupee Version)
 * Env bindings required: 
 * - DB (D1 Database binding)
 * - JWT_SECRET (Secret string for signing tokens)
 */

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- ROUTER ---
    
    // 1. Serve Static Assets (PWA)
    if (url.pathname === "/manifest.json") return serveManifest();
    if (url.pathname === "/sw.js") return serveServiceWorker();
    
    // 2. API Routes
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    // 3. Serve HTML Frontend (SPA)
    return serveHTML(env);
  }
};

// --- AUTHENTICATION LOGIC (PBKDF2 + JWT) ---

async function hashPassword(password, salt = null) {
  const enc = new TextEncoder();
  if (!salt) {
    salt = crypto.getRandomValues(new Uint8Array(16));
  } else {
    salt = Uint8Array.from(atob(salt), c => c.charCodeAt(0));
  }

  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits", "deriveKey"]
  );

  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
  );

  const exported = await crypto.subtle.exportKey("raw", key);
  const hash = btoa(String.fromCharCode(...new Uint8Array(exported)));
  const saltStr = btoa(String.fromCharCode(...salt));
  
  return { hash, salt: saltStr };
}

async function signJWT(payload, secret) {
  const enc = new TextEncoder();
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(`${encodedHeader}.${encodedPayload}`));
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

async function verifyJWT(request, secret) {
  const cookie = request.headers.get("Cookie");
  if (!cookie || !cookie.includes("auth_token=")) return null;
  
  const token = cookie.split("auth_token=")[1].split(";")[0];
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );

  const sigStr = atob(signature.replace(/-/g, "+").replace(/_/g, "/"));
  const sigBuf = Uint8Array.from(sigStr, c => c.charCodeAt(0));

  const isValid = await crypto.subtle.verify(
    "HMAC", key, sigBuf, enc.encode(`${header}.${payload}`)
  );

  if (!isValid) return null;
  return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
}

// --- API HANDLER ---

async function handleApi(request, env, url) {
  const path = url.pathname;
  
  // LOGIN / REGISTER
  if (path === "/api/auth" && request.method === "POST") {
    const { username, password, mode } = await request.json();
    
    if (mode === 'register') {
      const count = await env.DB.prepare("SELECT COUNT(*) as c FROM users").first('c');
      if (count >= (env.MAX_USERS || Infinity)) return new Response(JSON.stringify({ error: "User limit reached" }), { status: 403 });

      const { hash, salt } = await hashPassword(password);
      try {
        await env.DB.prepare("INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)")
          .bind(username, hash, salt).run();
        return new Response(JSON.stringify({ msg: "Registered" }), { status: 201 });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Username taken" }), { status: 400 });
      }
    } 
    
    // Login Mode
    const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
    if (!user) return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401 });
    
    const { hash } = await hashPassword(password, user.salt);
    if (hash !== user.password_hash) return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401 });

    const token = await signJWT({ id: user.id, username: user.username }, env.JWT_SECRET);
    const headers = new Headers(CORS_HEADERS);
    headers.append("Set-Cookie", `auth_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`);
    
    return new Response(JSON.stringify({ success: true }), { headers });
  }

  // LOGOUT
  if (path === "/api/logout") {
     const headers = new Headers(CORS_HEADERS);
     headers.append("Set-Cookie", `auth_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
     return new Response("Logged out", { headers });
  }

  // --- SECURITY GATE ---
  // Any code below this line requires a valid JWT.
  // Unauthenticated requests are halted here.
  const user = await verifyJWT(request, env.JWT_SECRET);
  if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  // TRANSACTIONS
  if (path === "/api/transactions") {
    
    // Add Transaction
    if (request.method === "POST") {
      const { type, reason, amount } = await request.json();
      await env.DB.prepare("INSERT INTO transactions (user_id, type, reason, amount, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(user.id, type, reason, parseFloat(amount), Date.now()).run();
      return new Response(JSON.stringify({ success: true }), { headers: CORS_HEADERS });
    }

    // Get Transactions
    if (request.method === "GET") {
      const page = parseInt(url.searchParams.get("page") || 1);
      const limit = 100;
      const offset = (page - 1) * limit;

      // UPDATE: Joined with 'users' table to get the author's name
      const txs = await env.DB.prepare(`
        SELECT transactions.*, users.username as author 
        FROM transactions 
        LEFT JOIN users ON transactions.user_id = users.id
        ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).bind(limit, offset).all();
      
      const totalResult = await env.DB.prepare(`
        SELECT 
          SUM(CASE WHEN type='credit' THEN amount ELSE 0 END) - 
          SUM(CASE WHEN type='debit' THEN amount ELSE 0 END) as total 
        FROM transactions`)
        .first();

      return new Response(JSON.stringify({ 
        transactions: txs.results, 
        total: totalResult.total || 0,
        user: user.username
      }), { headers: CORS_HEADERS });
    }
  }

  return new Response("Not Found", { status: 404 });
}

// --- FRONTEND GENERATION (HTML/CSS/JS) ---

function serveHTML(env) {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="theme-color" content="#1a1a1a">
    <link rel="manifest" href="/manifest.json">
    <title>Finance Tracker</title>
    <style>
        :root { --bg: #1a1a1a; --card: #2d2d2d; --text: #e0e0e0; --accent: #3b82f6; --green: #10b981; --red: #ef4444; }
        body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; min-height: 100vh; }
        .container { width: 100%; max-width: 500px; }
        input, select, button { width: 100%; padding: 12px; margin: 8px 0; border-radius: 8px; border: 1px solid #444; background: #333; color: white; font-size: 16px; box-sizing: border-box; }
        button { background: var(--accent); border: none; font-weight: bold; cursor: pointer; }
        .card { background: var(--card); padding: 20px; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        .hidden { display: none; }
        .tx-item { display: flex; justify-content: space-between; border-bottom: 1px solid #444; padding: 12px 0; align-items: center; }
        .tx-meta { font-size: 0.85em; color: #888; margin-top: 4px; }
        .credit { color: var(--green); }
        .debit { color: var(--red); }
        h1, h2, h3 { margin-top: 0; }
        .balance-box { text-align: center; font-size: 2em; font-weight: bold; margin: 10px 0; }
        .logout { background: #555; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container">
        
        <div id="loginView" class="card">
            <h2>Login</h2>
            <input type="text" id="userIn" placeholder="Username">
            <input type="password" id="passIn" placeholder="Password">
            <button onclick="auth('login')">Login</button>
            <button onclick="auth('register')" style="background:transparent; border:1px solid #555">Register</button>
        </div>

        <div id="appView" class="hidden">
            <div class="card">
                <div class="balance-box" id="totalBalance">...</div>
                <div style="text-align:center; color:#888; font-size:0.9em">Current Balance</div>
            </div>

            <div class="card">
                <h3>Add Entry</h3>
                <select id="txType">
                    <option value="debit">Debit (-)</option>
                    <option value="credit">Credit (+)</option>
                </select>
                <input type="number" id="txAmount" placeholder="Amount" step="0.01">
                <input type="text" id="txReason" placeholder="Reason (e.g. Groceries)">
                <button onclick="addTx()">Save</button>
            </div>

            <div class="card">
                <h3>History</h3>
                <div id="txList"></div>
            </div>

            <button class="logout" onclick="logout()">Logout</button>
        </div>
    </div>

<footer style="
    margin-top:40px;
    padding:20px;
    text-align:center;
    font-size:0.85em;
    color:#666;
">
    <div>By <strong>Abhinav Shrivastava</strong>  
        <a href="https://xanthis.xyz" target="_blank" style="color:#3b82f6; text-decoration:none;">(xanthis.xyz)</a>
    </div>

    <div style="margin-top:6px;">
        <a href="https://github.com/xanthisafk/cf-finance-tracker" 
           target="_blank" 
           style="color:#3b82f6; text-decoration:none;">
           Get the source (MIT)
        </a>
    </div>
</footer>


    <script>

        window.APP_CONFIG = {
            currency: "${env.CURRENCY_SYMBOL || "$"}",
            locale: "${env.FORCE_LOCALE || ""}"
        };

        document.getElementById("txAmount").placeholder = "Amount (${env.CURRENCY_SYMBOL || "$"})"

        // Service Worker Reg
        if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

        const api = async (url, method, body) => {
            const res = await fetch(url, { method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            if(res.status === 401) return logout();
            return res;
        };

        async function auth(mode) {
            const u = document.getElementById('userIn').value;
            const p = document.getElementById('passIn').value;
            const res = await api('/api/auth', 'POST', { username: u, password: p, mode });
            if(res.ok) {
                if(mode === 'register') alert('Registered! Now login.');
                else loadApp();
            } else {
                const data = await res.json();
                alert(data.error || 'Error');
            }
        }

        async function loadApp() {
            const res = await fetch('/api/transactions');
            if(res.status === 401) {
                document.getElementById('loginView').classList.remove('hidden');
                document.getElementById('appView').classList.add('hidden');
                return;
            }
            const data = await res.json();
            
            document.getElementById('loginView').classList.add('hidden');
            document.getElementById('appView').classList.remove('hidden');
            
            // Render Balance
            const bal = document.getElementById('totalBalance');
            const currency = window.APP_CONFIG.currency || "₹";
const locale = window.APP_CONFIG.locale || navigator.language;

bal.innerText = new Intl.NumberFormat(locale, { 
    style: "currency", 
    currency: "XXX" 
}).format(data.total).replace("XXX", currency);

            bal.style.color = data.total >= 0 ? 'var(--green)' : 'var(--red)';

            // Render List
            const list = document.getElementById('txList');
            if(data.transactions.length === 0) {
                list.innerHTML = '<div style="text-align:center; color:#555; padding:20px;">No transactions yet</div>';
            } else {
                list.innerHTML = data.transactions.map(t => \`
                    <div class="tx-item">
                        <div>
                            <div style="font-weight:bold">\${t.reason}</div>
                            <div class="tx-meta">
                                <span>\${new Date(t.created_at).toLocaleDateString()}</span>
                                <span style="margin: 0 5px">•</span>
                                <span style="color:var(--accent)">\${t.author || 'Unknown'}</span>
                            </div>
                        </div>
                        <div class="\${t.type}">
                            \${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2
}).format(t.amount).replace(/^/, (t.type === 'debit' ? '-' : '+') + currency)}

                        </div>
                    </div>
                \`).join('');
            }
        }

        async function addTx() {
            const type = document.getElementById('txType').value;
            const reason = document.getElementById('txReason').value;
            const amount = document.getElementById('txAmount').value;
            
            if(!reason || !amount) return alert('Fill all fields');

            await api('/api/transactions', 'POST', { type, reason, amount });
            document.getElementById('txReason').value = '';
            document.getElementById('txAmount').value = '';
            loadApp();
        }

        async function logout() {
            await fetch('/api/logout');
            window.location.reload();
        }

        // Init
        loadApp();
    </script>
</body>
</html>
  `;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

function serveManifest() {
    const json = {
        name: "Finance Tracker",
        short_name: "Finance",
        start_url: "/",
        display: "standalone",
        background_color: "#1a1a1a",
        theme_color: "#1a1a1a",
        icons: [{
            src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E₹%3C/text%3E%3C/svg%3E",
            sizes: "192x192",
            type: "image/svg+xml"
        }]
    };
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/manifest+json" } });
}

function serveServiceWorker() {
    const js = `
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('fetch', (event) => {});
    `;
    return new Response(js, { headers: { "Content-Type": "application/javascript" } });
}