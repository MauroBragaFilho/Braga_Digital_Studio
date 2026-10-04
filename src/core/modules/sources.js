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
  // Cada tipo ('cpu', 'cuda') tem uma tabela "<plataforma>-<arquitetura>" -> pacote OFICIAL da release. Combinação
  // ausente = o projeto oficial não publica binário (o recurso fica "indisponível neste sistema"). macOS: a release só
  // traz um xcframework (biblioteca para apps Xcode), não o whisper-cli; Linux não tem pacote CUDA oficial.
  // (Uma entrada com `name` direto, sem tabela, vale para qualquer sistema — usado nos testes.)
  assets: {
    cpu: {
      'win32-x64': {
        label: 'Motor de transcrição (CPU)',
        name: 'whisper-bin-x64.zip',
        size: 8573270,
        sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
      },
      'win32-arm64': {
        label: 'Motor de transcrição (CPU, Windows ARM)',
        name: 'whisper-bin-win-cpu-arm64.zip',
        size: 4361895,
        sha256: '799543b926ab5b6c2d60cab269a2092e0ae8d27820e9e15429e59de3699546fc'
      },
      'linux-x64': {
        label: 'Motor de transcrição (CPU, Linux)',
        name: 'whisper-bin-ubuntu-x64.tar.gz',
        size: 9793438,
        sha256: '53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32'
      },
      'linux-arm64': {
        label: 'Motor de transcrição (CPU, Linux ARM)',
        name: 'whisper-bin-ubuntu-arm64.tar.gz',
        size: 4605905,
        sha256: '93532a0e3777f26f041ffa358ee77dd88b1a33a86847c1990745327ff335a5d6'
      }
    },
    cuda: {
      'win32-x64': {
        label: 'Aceleração NVIDIA',
        name: 'whisper-cublas-12.4.0-bin-x64.zip',
        size: 674539285,
        sha256: 'af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7',
        cudaVersion: '12.4'
      }
    }
  }
};

/** Nome do programa e arquivo-marca da aceleração, por sistema (o pacote do Windows traz .exe/.dll). */
function engineFiles(platform = process.platform) {
  return platform === 'win32'
    ? { cli: 'whisper-cli.exe', cuda: 'ggml-cuda.dll' }
    : { cli: 'whisper-cli', cuda: 'libggml-cuda.so' };
}

/** Arquivos que precisam existir depois de extrair cada pacote (Windows; use engineFiles(plataforma)). */
const ENGINE_FILES = engineFiles('win32');

const SYSTEM_NAMES = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };
const systemName = (platform) => SYSTEM_NAMES[platform] || String(platform);

/** Explica, em português, por que o motor/aceleração não existe para o sistema. */
function unavailableReason(kind, platform = process.platform, arch = process.arch) {
  const sys = systemName(platform);
  const archNote = platform === 'darwin' ? '' : ` (${arch})`;
  if (kind === 'cuda') {
    return `A aceleração NVIDIA não está disponível neste sistema: o projeto oficial só publica esse pacote para Windows 64 bits. Em ${sys}${archNote} a transcrição roda na CPU.`;
  }
  return `Transcrição ainda não disponível neste sistema: o projeto oficial não publica o motor para ${sys}${archNote}.`;
}

const CUDA_LICENSE_LINKS = [
  { label: 'Termos de licença das bibliotecas da NVIDIA', url: 'https://docs.nvidia.com/cuda/eula/index.html' }
];

class WhisperCppSource {
  constructor({ baseUrl = 'https://github.com', release = WHISPER_CPP_RELEASE } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.release = release;
  }

  /** Há pacote oficial desse tipo para o sistema/arquitetura? */
  hasAsset(kind, platform = process.platform, arch = process.arch) {
    return Boolean(this._entry(kind, platform, arch));
  }

  _entry(kind, platform, arch) {
    const table = this.release.assets[kind];
    if (!table) return null;
    return table.name ? table : (table[`${platform}-${arch}`] || null);
  }

  /** @param {'cpu'|'cuda'} kind */
  asset(kind, platform = process.platform, arch = process.arch) {
    if (!this.release.assets[kind]) throw new Error(`Pacote desconhecido: ${kind}.`);
    const a = this._entry(kind, platform, arch);
    if (!a) throw new Error(unavailableReason(kind, platform, arch));
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
      throw new Error('A fonte do modelo respondeu de forma inesperada. Tente novamente mais tarde.');
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

module.exports = { WhisperCppSource, HuggingFaceSource, WHISPER_CPP_RELEASE, ENGINE_FILES, engineFiles, unavailableReason, CUDA_LICENSE_LINKS };
