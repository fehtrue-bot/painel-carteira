// Link da coordenação da Carteira de Serviços.
// A Fernanda publica o painel (com a senha do painel); quem tem o link só vê.
// GET  /api/carteira?k=<final do link>            -> versão publicada (hora, partes)
// GET  /api/carteira?k=<final>&v=<versão>&i=<n>   -> parte n do painel (gzip em base64)
// POST {acao:"info"}                             -> o link (criado sozinho na primeira vez)
// POST {acao:"parte",v,i,n,dados,dc}              -> grava o painel publicado
const crypto = require("crypto");
const acharEnv = (fim) => Object.entries(process.env).filter(([k, v]) => k.endsWith(fim) && !k.includes("READ_ONLY") && v).map(([, v]) => v)[0];
const URL_DB = acharEnv("REST_API_URL") || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = acharEnv("REST_API_TOKEN") || process.env.UPSTASH_REDIS_REST_TOKEN;
async function pipe(cmds) {
  if (!URL_DB || !TOKEN) throw Object.assign(new Error("Banco não configurado na Vercel (conecte o Upstash Redis em Storage)."), { status: 500 });
  const r = await fetch(URL_DB.replace(/\/$/, "") + "/pipeline", { method: "POST", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  if (!r.ok) throw Object.assign(new Error("Erro no banco: " + r.status), { status: 502 });
  return (await r.json()).map((x) => { if (x.error) throw Object.assign(new Error("Erro no banco: " + x.error), { status: 502 }); return x.result; });
}
const cmd = async (...c) => (await pipe([c]))[0];
const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const erro = (st, m) => Object.assign(new Error(m), { status: st });
const hash = (s, sal) => crypto.scryptSync(String(s), sal, 32).toString("hex");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const iguais = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
async function lerCorpo(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const ch = []; for await (const c of req) ch.push(c); const t = Buffer.concat(ch).toString("utf8"); return t ? JSON.parse(t) : {};
}
// "rt" = base do retrabalho; o resto = painel da carteira
const pre = (b) => (b === "rt" ? "rt" : "cart");
const limparChave = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const cfg = J(await cmd("GET", "cart:cfg"), null);
    if (req.method === "GET") {
      const q = req.query || {};
      const k = limparChave(q.k);
      if (!["coordenacao", "cordenacao"].includes(k) && !(cfg && cfg.chave && k && iguais(k, cfg.chave))) throw erro(404, "Este link não existe mais. Peça o link novo para a Fernanda.");
      if (q.i != null) {
        const dados = await cmd("GET", `${pre(q.b)}:p:${String(q.v || "").replace(/[^a-z0-9]/g, "")}:${Number(q.i) | 0}`);
        if (dados == null) throw erro(409, "O painel acabou de ser atualizado. Recarregue a página.");
        return res.status(200).json({ dados });
      }
      const meta = J(await cmd("GET", pre(q.b) + ":meta"), null);
      return res.status(200).json(meta ? { em: meta.em, v: meta.v, partes: meta.partes, dc: meta.dc } : { em: 0 });
    }
    if (req.method !== "POST") throw erro(405, "Método não aceito.");
    const b = await lerCorpo(req);
    // o link é criado sozinho na primeira vez e não muda mais
    let c = cfg;
    if (!c || !c.chave) { c = { chave: "coordenacao-" + crypto.randomBytes(3).toString("hex") }; await cmd("SET", "cart:cfg", JSON.stringify(c)); }
    if (b.acao === "info") {
      const meta = J(await cmd("GET", "cart:meta"), null);
      return res.status(200).json({ chave: "coordenacao", em: meta ? meta.em : 0, dc: meta ? meta.dc : "" });
    }
    if (b.acao === "parte") {
      const v = String(b.v || "").replace(/[^a-z0-9]/g, "").slice(0, 30), i = Number(b.i) | 0, n = Number(b.n) | 0;
      if (!v || n < 1 || n > 60 || i < 0 || i >= n || typeof b.dados !== "string" || b.dados.length > 3300000) throw erro(400, "Envio inválido.");
      const P = pre(b.b);
      await cmd("SET", `${P}:p:${v}:${i}`, b.dados, "EX", 60 * 60 * 24 * 60);
      if (i === n - 1) {
        const antiga = J(await cmd("GET", P + ":meta"), null);
        const meta = { v, partes: n, em: Date.now(), dc: String(b.dc || "").slice(0, 10) };
        await cmd("SET", P + ":meta", JSON.stringify(meta));
        if (antiga && antiga.v && antiga.v !== v) await pipe(Array.from({ length: antiga.partes }, (_, j) => ["EXPIRE", `${P}:p:${antiga.v}:${j}`, 300]));
        return res.status(200).json({ ok: true, em: meta.em, chave: "coordenacao" });
      }
      return res.status(200).json({ ok: true });
    }
    throw erro(400, "Ação desconhecida.");
  } catch (e) { res.status(e.status || 500).json({ erro: e.message || "Erro inesperado." }); }
};
