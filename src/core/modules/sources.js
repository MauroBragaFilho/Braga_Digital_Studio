'use strict';

/**
 * sources.js — Fontes oficiais de onde os módulos baixam seus componentes.
 *
 *  - Hugging Face: modelos do Whisper (formato faster-whisper / CTranslate2).
 *  - NVIDIA: bibliotecas CUDA (cuBLAS e cuDNN) pelos manifestos "redistrib" oficiais.
 *
 * Nada é redistribuído pelo BDS: tamanhos e SHA-256 vêm da própria fonte na hora da instalação.
 */

const { fetchJson } = require('./FileDownloader');

// Arquivos de um modelo faster-whisper necessários para executar (o resto do repositório é ignorado).
const MODEL_REQUIRED = [/^config\.json$/, /^model\.bin$/, /^tokenizer\.json$/, /^vocabulary\.(json|txt)$/, /^preprocessor_config\.json$/];

class HuggingFaceSource {
  constructor({ baseUrl = 'https://huggingface.co', getJson = fetchJson } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this._getJson = getJson;
  }

  /**
   * Lista os arquivos do modelo na revisão atual, com tamanho e SHA-256 (arquivos LFS).
   * @returns {Promise<{repoId:string, revision:string, license:string|null, files:Array<{path:string,size:number,sha256:string|null}>}>}
   */
  async getModelFiles(repoId) {
    // blobs=true inclui tamanho e o hash LFS. Repositórios renomeados respondem com redirecionamento.
    const info = await this._getJson(`${this.baseUrl}/api/models/${repoId}?blobs=true`);
    if (!info || !Array.isArray(info.siblings) || !info.sha) {
      throw new Error(`Resposta inesperada do Hugging Face para ${repoId}.`);
    }
    const files = info.siblings
      .filter((f) => MODEL_REQUIRED.some((re) => re.test(f.rfilename)))
      .map((f) => ({ path: f.rfilename, size: Number(f.size) || 0, sha256: (f.lfs && f.lfs.sha256) || null }));

    const names = files.map((f) => f.path);
    for (const needed of ['model.bin', 'config.json', 'tokenizer.json']) {
      if (!names.includes(needed)) throw new Error(`O repositório ${repoId} não contém ${needed}.`);
    }
    if (!names.some((n) => /^vocabulary\./.test(n))) throw new Error(`O repositório ${repoId} não contém o vocabulário.`);

    return {
      repoId: info.id || repoId,           // id canônico (repositórios podem ser renomeados)
      revision: info.sha,                  // fixa a revisão: todos os arquivos vêm do mesmo commit
      license: (info.cardData && info.cardData.license) || null,
      files
    };
  }

  fileUrl(repoId, revision, filePath) {
    return `${this.baseUrl}/${repoId}/resolve/${revision}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  }
}

/**
 * Versões fixadas (as mesmas que o motor foi construído e testado): CUDA 12.9.2 (cuBLAS) e
 * cuDNN 9.27.0 para CUDA 12. Para atualizar, troque aqui e valide o motor com as novas DLLs.
 */
const CUDA_PLAN = {
  cublas: { label: 'NVIDIA cuBLAS', manifest: 'compute/cuda/redist/redistrib_12.9.2.json', component: 'libcublas', dir: 'compute/cuda/redist' },
  cudnn: { label: 'NVIDIA cuDNN', manifest: 'compute/cudnn/redist/redistrib_9.27.0.json', component: 'cudnn', variant: 'cuda12', dir: 'compute/cudnn/redist' }
};

// DLLs que o faster-whisper (CTranslate2 4.x) carrega, e que são copiadas dos pacotes da NVIDIA.
const CUDA_DLL_PATTERNS = [/^cublas64_12\.dll$/i, /^cublasLt64_12\.dll$/i, /^cudnn.*64_9\.dll$/i];
const CUDA_REQUIRED_DLLS = ['cublas64_12.dll', 'cublasLt64_12.dll', 'cudnn64_9.dll'];

const CUDA_LICENSE_LINKS = [
  { label: 'CUDA Toolkit EULA (cuBLAS)', url: 'https://docs.nvidia.com/cuda/eula/index.html' },
  { label: 'cuDNN Software License Agreement', url: 'https://docs.nvidia.com/deeplearning/cudnn/sla/index.html' }
];

class NvidiaCudaSource {
  constructor({ baseUrl = 'https://developer.download.nvidia.com', getJson = fetchJson } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this._getJson = getJson;
  }

  /**
   * Resolve, nos manifestos oficiais da NVIDIA, o URL, tamanho e SHA-256 dos pacotes Windows.
   * @returns {Promise<Array<{id:string,label:string,version:string,url:string,sha256:string,size:number}>>}
   */
  async resolve() {
    const out = [];
    for (const [id, plan] of Object.entries(CUDA_PLAN)) {
      const manifest = await this._getJson(`${this.baseUrl}/${plan.manifest}`);
      const comp = manifest && manifest[plan.component];
      let entry = comp && comp['windows-x86_64'];
      if (entry && plan.variant) entry = entry[plan.variant];
      if (!entry || !entry.relative_path || !entry.sha256) {
        throw new Error(`O manifesto da NVIDIA não traz o pacote Windows de ${plan.label}.`);
      }
      out.push({
        id,
        label: plan.label,
        version: comp.version,
        url: `${this.baseUrl}/${plan.dir}/${entry.relative_path}`,
        sha256: entry.sha256,
        size: Number(entry.size) || 0
      });
    }
    return out;
  }
}

module.exports = { HuggingFaceSource, NvidiaCudaSource, CUDA_PLAN, CUDA_DLL_PATTERNS, CUDA_REQUIRED_DLLS, CUDA_LICENSE_LINKS, MODEL_REQUIRED };
