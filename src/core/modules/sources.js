'use strict';

/**
 * sources.js — Fontes oficiais de onde os módulos baixam seus componentes.
 *
 *  - GitHub (ggml-org/whisper.cpp, releases oficiais): o motor (whisper-cli) para CPU e a versão para
 *    placas NVIDIA (CUDA, que já traz as bibliotecas da NVIDIA).
 *  - Hugging Face (ggerganov/whisper.cpp): os modelos do Whisper no formato ggml.
 *
 * Nada é redistribuído pelo BDS. Os pacotes do motor ficam FIXADOS aqui (versão, tamanho e SHA-256), então só
 * o arquivo exato que foi testado é aceito. Os modelos mudam de revisão no Hugging Face, então tamanho e
 * SHA-256 deles vêm da própria fonte na hora da instalação.
 */

const { fetchJson } = require('./FileDownloader');

/**
 * Release do whisper.cpp testada com o BDS. Para atualizar: escolha uma tag "bNNNN" em
 * https://github.com/ggml-org/whisper.cpp/releases (as tags "vX.Y.Z" não trazem binários), confira o SHA-256 de
 * cada pacote (a página da release mostra "sha256:…"), troque os valores abaixo e rode a validação do motor.
 */
const WHISPER_CPP_RELEASE = {
  tag: 'b5130',
  assets: {
    cpu: {
      label: 'Motor de transcrição (CPU)',
      name: 'whisper-bin-x64.zip',
      size: 8573270,
      sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
    },
    cuda: {
      label: 'Aceleração NVIDIA (CUDA 12.4)',
      name: 'whisper-cublas-12.4.0-bin-x64.zip',
      size: 674539285,
      sha256: 'af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7',
      cudaVersion: '12.4'
    }
  }
};

/** Arquivos que precisam existir depois de extrair cada pacote. */
const ENGINE_FILES = { cli: 'whisper-cli.exe', cuda: 'ggml-cuda.dll' };

const CUDA_LICENSE_LINKS = [
  { label: 'CUDA Toolkit EULA (bibliotecas da NVIDIA)', url: 'https://docs.nvidia.com/cuda/eula/index.html' }
];

class WhisperCppSource {
  constructor({ baseUrl = 'https://github.com', release = WHISPER_CPP_RELEASE } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.release = release;
  }

  /** @param {'cpu'|'cuda'} kind */
  asset(kind) {
    const a = this.release.assets[kind];
    if (!a) throw new Error(`Pacote desconhecido: ${kind}.`);
    return {
      kind,
      label: a.label,
      tag: this.release.tag,
      name: a.name,
      size: a.size,
      sha256: a.sha256,
      cudaVersion: a.cudaVersion || null,
      url: `${this.baseUrl}/ggml-org/whisper.cpp/releases/download/${this.release.tag}/${a.name}`
    };
  }
}

class HuggingFaceSource {
  constructor({ baseUrl = 'https://huggingface.co', getJson = fetchJson } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this._getJson = getJson;
  }

  /**
   * Localiza um arquivo de modelo na revisão atual do repositório, com tamanho e SHA-256 (arquivos LFS).
   * @returns {Promise<{repoId:string, revision:string, license:string|null, file:{path:string,size:number,sha256:string|null}}>}
   */
  async getModelFile(repoId, fileName) {
    // blobs=true inclui tamanho e o hash LFS. Repositórios renomeados respondem com redirecionamento.
    const info = await this._getJson(`${this.baseUrl}/api/models/${repoId}?blobs=true`);
    if (!info || !Array.isArray(info.siblings) || !info.sha) {
      throw new Error(`Resposta inesperada do Hugging Face para ${repoId}.`);
    }
    const f = info.siblings.find((s) => s.rfilename === fileName);
    if (!f) throw new Error(`O repositório ${repoId} não contém ${fileName}.`);
    return {
      repoId: info.id || repoId,           // id canônico (repositórios podem ser renomeados)
      revision: info.sha,                  // fixa a revisão do arquivo baixado
      license: (info.cardData && info.cardData.license) || null,
      file: { path: f.rfilename, size: Number(f.size) || 0, sha256: (f.lfs && f.lfs.sha256) || null }
    };
  }

  fileUrl(repoId, revision, filePath) {
    return `${this.baseUrl}/${repoId}/resolve/${revision}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  }
}

module.exports = { WhisperCppSource, HuggingFaceSource, WHISPER_CPP_RELEASE, ENGINE_FILES, CUDA_LICENSE_LINKS };
