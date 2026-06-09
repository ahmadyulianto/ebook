// --- HELPER: TRIPAY SIGNATURE ---
async function generateSignature(privateKey, message) {
  const encoder = new TextEncoder();
  const secretData = encoder.encode(privateKey);
  const messageData = encoder.encode(message);
  const cryptoKey = await crypto.subtle.importKey("raw", secretData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- HELPER: WA GATEWAY ---
async function sendWhatsApp(cfg, target, message) {
  if (!target) return;
  const provider = (cfg.wa_gateway_provider || 'fonnte').toLowerCase().trim();
  let cleanTarget = target.replace(/[^0-9]/g, '');
  if (cleanTarget.startsWith('0')) cleanTarget = '62' + cleanTarget.substring(1);
  if (!cleanTarget.startsWith('62')) cleanTarget = '62' + cleanTarget;

  try {
    if (provider === 'fonnte' && cfg.fonnte_token) {
      const formData = new FormData();
      formData.append('target', cleanTarget);
      formData.append('message', message);
      await fetch('https://api.fonnte.com/send', { method: 'POST', headers: { 'Authorization': cfg.fonnte_token }, body: formData });
    } else if (provider === 'starsender' && cfg.starsender_token) {
      await fetch('https://api.starsender.online/api/sendText', {
        method: 'POST', headers: { 'Authorization': cfg.starsender_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tujuan: cleanTarget, pesan: message })
      });
    }
  } catch (e) { console.error("Error WA Gateway:", e); }
}

function getWebsiteUrl(cfg, request) {
  let websiteUrl = (cfg.website_url || '').trim() || request.headers.get('origin') || '';
  if (websiteUrl && !websiteUrl.startsWith('http://') && !websiteUrl.startsWith('https://')) {
    websiteUrl = 'https://' + websiteUrl;
  }
  return websiteUrl.replace(/\/+$/, '');
}

function formatRupiah(amount) {
  return 'Rp ' + Number(amount || 0).toLocaleString('id-ID');
}

const DEFAULT_ADMIN_USERNAME = "mimin";
const DEFAULT_ADMIN_PASSWORD = "rahasia123";
const PUBLIC_SECRET_SETTING_KEYS = new Set([
  "admin_password",
  "tripay_api_key",
  "tripay_private_key",
  "imagekit_private_key",
  "fonnte_token",
  "starsender_token"
]);

function rowsToSettings(rows = []) {
  const cfg = {};
  rows.forEach((row) => {
    if (row && row.key_name) cfg[row.key_name] = row.key_value || "";
  });
  return cfg;
}

function toPublicSettings(cfg = {}) {
  const safe = {};
  Object.keys(cfg).forEach((key) => {
    if (!PUBLIC_SECRET_SETTING_KEYS.has(key)) safe[key] = cfg[key];
  });
  return safe;
}

function sanitizeAdminSettingsRows(rows = []) {
  return rows.map((row) => {
    if (row && row.key_name === "admin_password") {
      return { ...row, key_value: "" };
    }
    return row;
  });
}

function getSettingValue(value, fallback) {
  const normalized = value === undefined || value === null ? "" : String(value);
  return normalized === "" ? fallback : normalized;
}

function encodeBasicToken(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  bytes.forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary);
}

function decodeBasicToken(token) {
  const binary = atob(token);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const decoded = new TextDecoder().decode(bytes);
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) return null;
  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1)
  };
}

async function getAdminCredentials(env) {
  try {
    const { results } = await env.DB.prepare("SELECT key_name, key_value FROM settings WHERE key_name IN ('admin_username', 'admin_password')").all();
    const cfg = rowsToSettings(results);
    return {
      username: getSettingValue(cfg.admin_username, DEFAULT_ADMIN_USERNAME),
      password: getSettingValue(cfg.admin_password, DEFAULT_ADMIN_PASSWORD)
    };
  } catch (e) {
    return { username: DEFAULT_ADMIN_USERNAME, password: DEFAULT_ADMIN_PASSWORD };
  }
}

async function isAdminAuthorized(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Basic ")) return false;
  try {
    const submitted = decodeBasicToken(authHeader.slice(6));
    if (!submitted) return false;
    const credentials = await getAdminCredentials(env);
    return submitted.username === credentials.username && submitted.password === credentials.password;
  } catch (e) {
    return false;
  }
}

async function getMemberLoginInfo(env, cfg, request, whatsapp) {
  const websiteUrl = getWebsiteUrl(cfg, request);
  const user = await env.DB.prepare("SELECT whatsapp, password FROM users WHERE whatsapp = ?").bind(whatsapp).first();
  const username = user?.whatsapp || whatsapp;
  const password = user?.password || whatsapp;
  return `\u{1F511} *Info Login Member*
\u{1F310} Link Login:
${websiteUrl}/login.html
\u{1F464} Username: *${username}*
\u{1F512} Password: *${password}*`;
}

export default {
  async fetch(request, env) {
    const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400" };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);

    // 1. API HOME & PRODUCTS (Modifikasi dari API Campaign)
    if (url.pathname === "/api/home" || url.pathname === "/api/campaign") {
      const isDetail = url.pathname === "/api/campaign";
      const query = isDetail ? "WHERE c.id = ?" : "WHERE c.is_active = 1";
      const params = isDetail ? [url.searchParams.get("id")] : [];

      // Mengambil total transaksi sukses sebagai 'terjual'
      const sql = `
        SELECT c.*,
        (SELECT COUNT(id) FROM donations WHERE campaign_id = c.id AND status = 'success') as terjual_count
        FROM campaigns c ${query}
      `;
      
      const dbRes = isDetail ? await env.DB.prepare(sql).bind(...params).first() : (await env.DB.prepare(sql).all()).results;
      
      let responseData = isDetail ? dbRes : { campaigns: dbRes };
      if (isDetail && dbRes) {
          // Asumsi 'target' di DB digunakan sebagai Harga Produk
          dbRes.harga = parseInt(dbRes.target || 0); 
          dbRes.terjual = dbRes.terjual_count;
      } else if (!isDetail) {
          responseData.campaigns.forEach(c => {
              c.harga = parseInt(c.target || 0);
              c.terjual = c.terjual_count;
          });
          const { results: b } = await env.DB.prepare("SELECT * FROM banners WHERE is_active = 1").all();
          const { results: s } = await env.DB.prepare("SELECT * FROM settings").all();
          const cfg = rowsToSettings(s);
          responseData.banners = b; responseData.settings = toPublicSettings(cfg);
      }
      return new Response(JSON.stringify(responseData), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // 2. API BERITA / ARTIKEL
    if (url.pathname === "/api/news") {
      if (request.method === "GET") {
        const id = url.searchParams.get("id");
        if (id) {
          const row = await env.DB.prepare("SELECT * FROM news WHERE id = ?").bind(id).first();
          return new Response(JSON.stringify(row), { headers: { "Content-Type": "application/json", ...corsHeaders } });
        } else {
          const { results } = await env.DB.prepare("SELECT * FROM news ORDER BY created_at DESC").all();
          return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json", ...corsHeaders } });
        }
      }
      if (request.method === "POST") {
        const data = await request.json();
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO news (id, title, image_url, content) VALUES (?, ?, ?, ?)").bind(id, data.title, data.image_url, data.content).run();
        return new Response(JSON.stringify({ status: "success", id: id }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
      }
    }

    // 3. API USER & AUTHENTICATION
    if (url.pathname === "/api/user/auth" && request.method === "POST") {
      const data = await request.json();
      if (data.action === "register") {
        const existing = await env.DB.prepare("SELECT id FROM users WHERE whatsapp = ?").bind(data.whatsapp).first();
        if (existing) return new Response(JSON.stringify({status: "error", message: "Nomor WhatsApp ini sudah terdaftar."}), {headers: corsHeaders});
        const newId = "usr_" + Date.now().toString(36) + Math.random().toString(36).substr(2);
        await env.DB.prepare("INSERT INTO users (id, nama, whatsapp, password, saldo) VALUES (?, ?, ?, ?, 0)").bind(newId, data.nama, data.whatsapp, data.password || data.whatsapp).run();
        return new Response(JSON.stringify({ status: "success", user: { id: newId, nama: data.nama, whatsapp: data.whatsapp, saldo: 0 } }), {headers: corsHeaders});
      }
      if (data.action === "login") {
        const user = await env.DB.prepare("SELECT id, nama, whatsapp, saldo FROM users WHERE whatsapp = ? AND password = ?").bind(data.whatsapp, data.password).first();
        if (user) return new Response(JSON.stringify({status: "success", user: user}), {headers: corsHeaders});
        return new Response(JSON.stringify({status: "error", message: "Nomor WhatsApp atau Password salah."}), {headers: corsHeaders});
      }
      
      if (data.action === "profile") {
        const user = await env.DB.prepare("SELECT id, nama, whatsapp, saldo FROM users WHERE id = ?").bind(data.id).first();
        if(user) return new Response(JSON.stringify({status: "success", user: user}), {headers: corsHeaders});
        return new Response(JSON.stringify({status: "error"}), {headers: corsHeaders});
      }

      if (data.action === "history") {
        // Tarik data transaksi beserta gambar dan tipe produknya
        const history = await env.DB.prepare(`
          SELECT d.*, c.title as campaign_title, c.image_url, c.tipe_produk 
          FROM donations d 
          LEFT JOIN campaigns c ON d.campaign_id = c.id 
          WHERE d.whatsapp = ? 
          ORDER BY d.created_at DESC
        `).bind(data.whatsapp).all();
        return new Response(JSON.stringify({status: "success", data: history.results}), {headers: corsHeaders});
      }
    }

    // 4. API CHECKOUT (Mendukung Pembelian Produk & Topup)
    if (url.pathname === "/api/checkout" && request.method === "POST") {
      const data = await request.json();
      const { results: s } = await env.DB.prepare("SELECT * FROM settings").all();
      const cfg = {}; s.forEach(r => cfg[r.key_name] = r.key_value);
      const websiteUrl = getWebsiteUrl(cfg, request);
      const invId = "INV-" + Date.now().toString(36).toUpperCase();
      // OTOMATIS BUAT AKUN JIKA BELUM ADA
      const checkUser = await env.DB.prepare("SELECT id FROM users WHERE whatsapp = ?").bind(data.whatsapp).first();
      if (!checkUser) {
          const newUsrId = "usr_" + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
          // Password diset sama persis dengan nomor WhatsApp
          await env.DB.prepare("INSERT INTO users (id, nama, whatsapp, password, saldo) VALUES (?, ?, ?, ?, 0)")
            .bind(newUsrId, data.nama, data.whatsapp, data.whatsapp).run();
      }
      let campTitle = "Top Up Saldo Akun";
      if (data.campaign_id !== 'SALDO') {
          const camp = await env.DB.prepare("SELECT title FROM campaigns WHERE id = ?").bind(data.campaign_id).first();
          if(camp) campTitle = camp.title;
      }

      // --- LOGIKA BAYAR PAKAI SALDO SAKU ---
      if (data.metode_pembayaran === 'SALDO' && data.campaign_id !== 'SALDO') {
          const user = await env.DB.prepare("SELECT saldo FROM users WHERE whatsapp = ?").bind(data.whatsapp).first();
          if(!user || user.saldo < data.nominal) {
              return new Response(JSON.stringify({ status: "error", message: "Saldo Akun tidak mencukupi." }), { headers: corsHeaders });
          }

          // Potong Saldo User
          await env.DB.prepare("UPDATE users SET saldo = saldo - ? WHERE whatsapp = ?").bind(parseInt(data.nominal), data.whatsapp).run();
          
          // Insert transaksi sukses
          await env.DB.prepare("INSERT INTO donations (id, campaign_id, nama, whatsapp, doa, nominal, metode_pembayaran, status) VALUES (?,?,?,?,?,?,?,?)")
            .bind(invId, data.campaign_id, data.nama, data.whatsapp, data.doa || '', parseInt(data.nominal), 'SALDO AKUN', 'success').run();

          const loginInfo = await getMemberLoginInfo(env, cfg, request, data.whatsapp);
          const msg = `\u2705 *Pesanan Berhasil!*

Halo *${data.nama}*,
Pesanan kamu sudah aktif dan pembayaran berhasil diproses menggunakan *Saldo Akun*.

\u{1F4E6} Produk: *${campTitle}*
\u{1F9FE} Invoice: *${invId}*
\u{1F4B3} Metode: Saldo Akun

\u{1F517} Akses pesanan:
${websiteUrl}/invoice.html?id=${invId}

${loginInfo}

Terima kasih sudah berbelanja \u{1F64F}`;
          await sendWhatsApp(cfg, data.whatsapp, msg);
          
          return new Response(JSON.stringify({ status: "success", invoice_id: invId }), { headers: { ...corsHeaders } });
      }
      if (data.metode_pembayaran === 'FREE' || parseInt(data.nominal) === 0) {
          // Insert data langsung dengan status 'success'
          await env.DB.prepare("INSERT INTO donations (id, campaign_id, nama, whatsapp, doa, nominal, metode_pembayaran, status) VALUES (?,?,?,?,?,?,?,?)")
            .bind(invId, data.campaign_id, data.nama, data.whatsapp, data.doa || '', 0, 'GRATIS', 'success').run();

          // Kirim Notifikasi Akses Instan
          const loginInfo = await getMemberLoginInfo(env, cfg, request, data.whatsapp);
          const msg = `\u{1F381} *Akses Gratis Berhasil Dibuka!*

Halo *${data.nama}*,
Produk digital kamu sudah aktif dan siap digunakan.

\u{1F4E6} Produk: *${campTitle}*
\u{1F9FE} Invoice: *${invId}*
\u{1F4B3} Metode: Gratis

\u{1F510} Masuk ke Member Area:
${websiteUrl}/pesanan-saya.html

${loginInfo}

Selamat menikmati produknya \u2728`;
          await sendWhatsApp(cfg, data.whatsapp, msg);
          
          return new Response(JSON.stringify({ status: "success", invoice_id: invId }), { headers: { ...corsHeaders } });
      }
      // Gateway Tripay
      if (cfg.payment_system_mode === 'gateway') {
        const tMethod = data.metode_pembayaran === 'BCA' ? 'BCAVA' : (data.metode_pembayaran === 'MANDIRI' ? 'MANDIRIVA' : data.metode_pembayaran);
        const tripayUrl = cfg.tripay_mode === "production" ? "https://tripay.co.id/api/transaction/create" : "https://tripay.co.id/api-sandbox/transaction/create";
        const signature = await generateSignature(cfg.tripay_private_key, cfg.tripay_merchant_code + invId + data.nominal);
        
        const tripayPayload = {
          method: tMethod, merchant_ref: invId, amount: parseInt(data.nominal),
          customer_name: data.nama, customer_email: "member@platform.com", customer_phone: data.whatsapp || "08123456789",
          order_items: [{ name: campTitle.substring(0, 45), price: parseInt(data.nominal), quantity: 1 }],
          expired_time: Math.floor(Date.now() / 1000) + (24 * 3600), signature: signature
        };
        const tripayRes = await fetch(tripayUrl, { method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.tripay_api_key, 'Content-Type': 'application/json' }, body: JSON.stringify(tripayPayload) });
        const tData = await tripayRes.json();
        if (!tData.success) throw new Error(tData.message);
        const paymentCode = tData.data.pay_code || '';
        const qrOrCheckout = tData.data.qr_string || tData.data.qr_url || tData.data.checkout_url || tData.data.pay_url || tData.data.payment_url || '';
        
        await env.DB.prepare("INSERT INTO donations (id, campaign_id, nama, whatsapp, doa, nominal, metode_pembayaran, status, reference, pay_code, qr_string, fee) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
          .bind(invId, data.campaign_id, data.nama, data.whatsapp, data.doa || '', tData.data.amount, data.metode_pembayaran, 'pending', tData.data.reference, paymentCode, qrOrCheckout, tData.data.fee || 0).run();
      } else {
        const nominal = parseInt(data.nominal) + Math.floor(Math.random() * 999) + 1;
        await env.DB.prepare("INSERT INTO donations (id, campaign_id, nama, whatsapp, doa, nominal, metode_pembayaran, status) VALUES (?,?,?,?,?,?,?,?)")
          .bind(invId, data.campaign_id, data.nama, data.whatsapp, data.doa || '', nominal, data.metode_pembayaran, 'pending').run();
      }

      const msg = `\u{1F9FE} *Tagihan Pesanan Dibuat*

Halo *${data.nama}*,
Pesanan kamu sudah kami terima. Silakan selesaikan pembayaran agar akses produk bisa segera dibuka.

\u{1F4E6} Produk: *${campTitle}*
\u{1F9FE} Invoice: *${invId}*
\u{1F4B0} Total: *${formatRupiah(data.nominal)}*
\u{1F4B3} Metode: *${data.metode_pembayaran}*

\u{1F517} Lihat tagihan:
${websiteUrl}/invoice.html?id=${invId}

Terima kasih \u{1F64F}`;
      await sendWhatsApp(cfg, data.whatsapp, msg);
      return new Response(JSON.stringify({ status: "success", invoice_id: invId }), { headers: { ...corsHeaders } });
    }

    // 5. API INVOICE
    if (url.pathname === "/api/invoice") {
      const inv = await env.DB.prepare("SELECT d.*, c.title as campaign_title FROM donations d LEFT JOIN campaigns c ON d.campaign_id = c.id WHERE d.id = ?").bind(url.searchParams.get("id")).first();
      const { results: s } = await env.DB.prepare("SELECT * FROM settings").all();
      const cfg = rowsToSettings(s);
      if (inv) {
          inv.payment_info = toPublicSettings(cfg);
          if (inv.campaign_id === 'SALDO') inv.campaign_title = 'Top Up Saldo Akun';
      }
      return new Response(JSON.stringify(inv), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // 6. CALLBACK TRIPAY
    if (url.pathname === "/api/tripay-callback" && request.method === "POST") {
      const rawBody = await request.text(); const callbackData = JSON.parse(rawBody);
      const { results: s } = await env.DB.prepare("SELECT * FROM settings").all();
      const cfg = {}; s.forEach(r => cfg[r.key_name] = r.key_value);

      const calculatedSignature = await generateSignature(cfg.tripay_private_key, rawBody);
      if (calculatedSignature !== request.headers.get('X-Callback-Signature')) return new Response("Invalid", { status: 401 });

      if (callbackData.status === "PAID") {
        const invId = callbackData.merchant_ref;
        const doc = await env.DB.prepare("SELECT * FROM donations WHERE id = ?").bind(invId).first();
        if (doc && doc.status === "pending") {
          await env.DB.prepare("UPDATE donations SET status = 'success' WHERE id = ?").bind(invId).run();
          
          if (doc.campaign_id === 'SALDO') {
              await env.DB.prepare("UPDATE users SET saldo = saldo + ? WHERE whatsapp = ?").bind(doc.nominal, doc.whatsapp).run();
              const loginInfo = await getMemberLoginInfo(env, cfg, request, doc.whatsapp);
              await sendWhatsApp(cfg, doc.whatsapp, `\u{1F4B0} *Top Up Saldo Berhasil!*

Saldo akun kamu sudah bertambah.

\u2705 Nominal: *${formatRupiah(doc.nominal)}*
\u{1F9FE} Invoice: *${invId}*

${loginInfo}

Terima kasih, saldo sudah siap digunakan \u2728`);
          } else {
              const websiteUrl = getWebsiteUrl(cfg, request);
              const loginInfo = await getMemberLoginInfo(env, cfg, request, doc.whatsapp);
              await sendWhatsApp(cfg, doc.whatsapp, `\u2705 *Pembayaran Berhasil!*

Pesanan kamu sudah aktif dan akses produk telah dibuka.

\u{1F9FE} Invoice: *${invId}*

\u{1F510} Cek produk kamu di Member Area:
${websiteUrl}/pesanan-saya.html

${loginInfo}

Terima kasih sudah berbelanja \u{1F64F}`);
          }
        }
      }
      return new Response("OK", { status: 200 });
    }

    // 7. ADMIN PANEL
    if (url.pathname === "/api/admin" && request.method === "POST") {
      const body = await request.json();
      if (body.action === "login") {
        const credentials = await getAdminCredentials(env);
        if (String(body.username || "") === credentials.username && String(body.password || "") === credentials.password) {
          return new Response(JSON.stringify({
            status: "success",
            token: encodeBasicToken(credentials.username, credentials.password),
            username: credentials.username
          }), { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ status: "error", message: "Kredensial salah" }), { headers: corsHeaders });
      }

      if (!await isAdminAuthorized(request, env)) {
        return new Response(JSON.stringify({ status: "error", message: "Sesi admin tidak valid. Silakan login ulang." }), { status: 401, headers: corsHeaders });
      }

      if (body.action === "update_admin_credentials") {
        const currentCredentials = await getAdminCredentials(env);
        const nextUsername = String(body.username || "").trim() || currentCredentials.username;
        const nextPassword = body.password ? String(body.password) : currentCredentials.password;

        await env.DB.prepare(`
          INSERT INTO settings (key_name, key_value)
          VALUES (?, ?)
          ON CONFLICT(key_name) DO UPDATE SET key_value = excluded.key_value
        `).bind("admin_username", nextUsername).run();

        if (body.password) {
          await env.DB.prepare(`
            INSERT INTO settings (key_name, key_value)
            VALUES (?, ?)
            ON CONFLICT(key_name) DO UPDATE SET key_value = excluded.key_value
          `).bind("admin_password", nextPassword).run();
        }

        return new Response(JSON.stringify({
          status: "success",
          token: encodeBasicToken(nextUsername, nextPassword),
          username: nextUsername
        }), { headers: corsHeaders });
      }
      
      if (body.action === "validate_donation") {
        const doc = await env.DB.prepare("SELECT * FROM donations WHERE id = ?").bind(body.id).first();
        if (doc && doc.status === 'pending') {
            await env.DB.prepare("UPDATE donations SET status = 'success' WHERE id = ?").bind(body.id).run();
            const { results: s } = await env.DB.prepare("SELECT * FROM settings").all();
            const cfg = {}; s.forEach(r => cfg[r.key_name] = r.key_value);
            if (doc.campaign_id === 'SALDO') {
                await env.DB.prepare("UPDATE users SET saldo = saldo + ? WHERE whatsapp = ?").bind(doc.nominal, doc.whatsapp).run();
                const loginInfo = await getMemberLoginInfo(env, cfg, request, doc.whatsapp);
                await sendWhatsApp(cfg, doc.whatsapp, `\u{1F4B0} *Top Up Saldo Berhasil!*

Halo *${doc.nama}*,
Saldo akun kamu sudah berhasil ditambahkan.

\u2705 Nominal: *${formatRupiah(doc.nominal)}*
\u{1F9FE} Invoice: *${doc.id}*

${loginInfo}

Terima kasih, saldo sudah siap digunakan \u2728`);
            } else {
                const websiteUrl = getWebsiteUrl(cfg, request);
                const camp = await env.DB.prepare("SELECT title FROM campaigns WHERE id = ?").bind(doc.campaign_id).first();
                const campTitle = camp ? camp.title : "Produk Digital";
                const loginInfo = await getMemberLoginInfo(env, cfg, request, doc.whatsapp);
                await sendWhatsApp(cfg, doc.whatsapp, `\u2705 *Pembayaran Dikonfirmasi!*

Halo *${doc.nama}*,
Pembayaran kamu sudah kami validasi. Akses produk sekarang sudah aktif.

\u{1F4E6} Produk: *${campTitle}*
\u{1F9FE} Invoice: *${doc.id}*

\u{1F510} Buka Member Area:
${websiteUrl}/pesanan-saya.html

${loginInfo}

Terima kasih sudah berbelanja \u{1F64F}`);
            }
            return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ status: "error", message: "Sudah tervalidasi." }), { headers: corsHeaders });
      }

      if (body.action === "read") {
        const info = await env.DB.prepare(`PRAGMA table_info(${body.table})`).all();
        const { results } = await env.DB.prepare(`SELECT * FROM ${body.table} ORDER BY rowid DESC`).all();
        const safeResults = body.table === "settings" ? sanitizeAdminSettingsRows(results) : results;
        return new Response(JSON.stringify({ status: "success", headers: info.results.map(c => c.name), data: safeResults }), { headers: corsHeaders });
      }
      // GABUNGAN FUNGSI ADD & UPDATE (Untuk mengatasi data baru maupun lama)
      if (body.action === "add" || body.action === "update") {
        
        if (body.table === 'settings') {
            // 1. Tangkap nama key-nya (Misal: 'imagekit_private_key')
            let keyName = body.id || body.data.key_name;
            if (!keyName) {
                // Jika body.id kosong, paksa ambil dari nama properti data pertama
                keyName = Object.keys(body.data)[0];
            }

            // 2. Tangkap isinya (Misal: 'private_NIN7RUE9t/7cdD6PcoHGldp72Hc=')
            let keyValue = "";
            if (body.data.key_value !== undefined) {
                keyValue = body.data.key_value;
            } else if (body.data[keyName] !== undefined) {
                keyValue = body.data[keyName];
            } else {
                keyValue = Object.values(body.data)[0];
            }

            // 3. Bersihkan kalau terdeteksi undefined
            if (keyValue === undefined || keyValue === null || String(keyValue) === "undefined") {
                keyValue = "";
            }

            // 4. Paksa masuk HANYA ke kolom key_name dan key_value
            await env.DB.prepare(`
                INSERT INTO settings (key_name, key_value)
                VALUES (?, ?)
                ON CONFLICT(key_name) DO UPDATE SET key_value = excluded.key_value
            `).bind(keyName, String(keyValue)).run();

            return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
            
        } else {
            // Logika Normal untuk tabel SELAIN settings (Produk, User, Berita)
            if (body.action === "add") {
                const keys = Object.keys(body.data); 
                const values = Object.values(body.data);
                await env.DB.prepare(`INSERT INTO ${body.table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).bind(...values).run();
                return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
            } 
            if (body.action === "update") {
                const keys = Object.keys(body.data); 
                const values = Object.values(body.data);
                await env.DB.prepare(`UPDATE ${body.table} SET ${keys.map(k=>k+'=?').join(',')} WHERE id=?`).bind(...values, body.id).run();
                return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
            }
        }
      }
      
      // FUNGSI DELETE
      if (body.action === "delete") {
        const primaryKeyCol = body.table === 'settings' ? 'key_name' : 'id';
        await env.DB.prepare(`DELETE FROM ${body.table} WHERE ${primaryKeyCol}=?`).bind(body.id).run();
        return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
      }
    }

    try { return await env.ASSETS.fetch(request); } catch (e) { return new Response("Not Found", { status: 404 }); }
  }
};
