// =====================================================================
// Gravador de consulta — servidor
//
// Serve a página de gravação (celular) e expõe dois endpoints que ela usa.
// A página é ANÔNIMA: quem autoriza é o token de 6 dígitos, validado aqui
// com a service_role. Por isso a validação nunca acontece no navegador.
// =====================================================================

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  BUCKET = 'gravacoes',
  PORT = 3000,
} = process.env;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY })) {
  if (!v) { console.error(`Variável obrigatória ausente: ${k}`); process.exit(1); }
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
app.use(express.json({ limit: '1mb' }));

const aqui = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(aqui, 'public')));

const log = (...a) => console.log(new Date().toISOString(), ...a);

// extensões aceitas — lista fechada de propósito: o valor vem do
// navegador e entra na montagem do caminho no storage.
const EXTENSOES = new Set(['webm', 'm4a', 'mp4', 'ogg', 'wav']);

const ehUuid = v =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);


// ---------------------------------------------------------------------
// POST /api/validar
// Recebe sessão + token digitado. Se conferir, devolve uma URL assinada
// de upload, válida só para aquele caminho.
// ---------------------------------------------------------------------
app.post('/api/validar', async (req, res) => {
  try {
    const { sessao_id, token, ext } = req.body || {};

    if (!ehUuid(sessao_id)) return res.status(400).json({ erro: 'sessao_invalida' });
    if (typeof token !== 'string' || !/^\d{4,8}$/.test(token))
      return res.status(400).json({ erro: 'token_invalido' });
    if (!EXTENSOES.has(ext)) return res.status(400).json({ erro: 'formato_nao_suportado' });

    const { data, error } = await db.rpc('validar_token_gravacao', {
      p_sessao_id: sessao_id,
      p_token: token,
    });
    if (error) throw new Error(error.message);

    if (!data?.ok) {
      log(`validação recusada (${sessao_id}): ${data?.motivo}`);
      // 200 de propósito: o motivo é informação de UI, não erro de rede
      return res.json({ ok: false, motivo: data?.motivo || 'desconhecido' });
    }

    const caminho = `${data.audio_path}.${ext}`;

    const { data: assinada, error: errAss } =
      await db.storage.from(BUCKET).createSignedUploadUrl(caminho);
    if (errAss) throw new Error(errAss.message);

    log(`sessão ${sessao_id}: token aceito, upload liberado`);
    res.json({ ok: true, url_upload: assinada.signedUrl, caminho });

  } catch (e) {
    log(`ERRO /api/validar: ${e.message}`);
    res.status(500).json({ erro: 'falha_interna' });
  }
});


// ---------------------------------------------------------------------
// POST /api/concluir
// O áudio já subiu: joga a sessão na fila do worker.
// ---------------------------------------------------------------------
app.post('/api/concluir', async (req, res) => {
  try {
    const { sessao_id, caminho } = req.body || {};

    if (!ehUuid(sessao_id)) return res.status(400).json({ erro: 'sessao_invalida' });
    if (typeof caminho !== 'string' || !caminho.includes(sessao_id))
      return res.status(400).json({ erro: 'caminho_invalido' });

    const { data, error } = await db.rpc('concluir_envio_gravacao', {
      p_sessao_id: sessao_id,
      p_audio_path: caminho,
    });
    if (error) throw new Error(error.message);

    if (!data?.ok) return res.json({ ok: false, motivo: data?.motivo });

    log(`sessão ${sessao_id}: áudio enviado, na fila`);
    res.json({ ok: true });

  } catch (e) {
    log(`ERRO /api/concluir: ${e.message}`);
    res.status(500).json({ erro: 'falha_interna' });
  }
});


app.get('/saude', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => log(`gravador no ar na porta ${PORT}`));
