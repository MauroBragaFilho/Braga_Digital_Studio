'use strict';
/**
 * whisper-cli de mentira para os testes: lê os argumentos como o programa real, grava <-of>.json a partir da
 * fixture (ou de FAKE_JSON), imprime as mesmas linhas de log e registra o que recebeu em FAKE_RECORD.
 *
 * Variáveis de ambiente: FAKE_JSON (arquivo .json de saída), FAKE_GPU=1 (age como motor com CUDA),
 * FAKE_FAIL_GPU=1 (com GPU e sem -ng, falha), FAKE_SLEEP=ms (demora, para testar o cancelamento),
 * FAKE_RECORD (arquivo onde cada chamada é registrada, uma linha de JSON).
 */
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const noGpu = args.includes('-ng');

if (process.env.FAKE_RECORD) {
  fs.appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ args, cwd: process.cwd(), noGpu, audioBytes: (() => { try { return fs.statSync(path.resolve(process.cwd(), val('-f'))).size; } catch (_) { return -1; } })() })}\n`);
}

const wantsGpu = process.env.FAKE_GPU === '1' && !noGpu;
if (wantsGpu) {
  console.error('ggml_cuda_init: found 1 CUDA devices (Total VRAM: 4095 MiB):');
  console.error('  Device 0: NVIDIA GeForce GTX 1650, compute capability 7.5, VMM: yes, VRAM: 4095 MiB');
  if (process.env.FAKE_FAIL_GPU === '1') {
    console.error('CUDA error: out of memory');
    process.exit(1);
  }
  console.error('whisper_backend_init_gpu: using CUDA0 backend');
}

const model = val('-m');
const audio = val('-f');
if (!model || !fs.existsSync(path.resolve(process.cwd(), model))) { console.error(`error: failed to open model '${model}'`); process.exit(2); }
if (!audio || !fs.existsSync(path.resolve(process.cwd(), audio))) { console.error(`error: input file not found '${audio}'`); process.exit(2); }

const finish = () => {
  for (const pct of [25, 60, 100]) console.error(`whisper_print_progress_callback: progress = ${String(pct).padStart(3)}%`);
  const out = path.resolve(process.cwd(), `${val('-of') || 'out'}.json`);
  const source = process.env.FAKE_JSON || path.join(__dirname, 'whispercpp-sample.json');
  fs.writeFileSync(out, fs.readFileSync(source));
  console.error(`output_json: saving output to '${out}'`);
};

const sleep = Number(process.env.FAKE_SLEEP) || 0;
if (sleep) setTimeout(finish, sleep); else finish();
