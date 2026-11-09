// Textos fixos das mensagens novas (ponto único para futura i18n). Uso: t('chave', { n: 3 })
const STRINGS = {
  'common.retry': 'Tentar novamente',
  'screen.loadError': 'Erro ao carregar a página.',
  'library.loading': 'Carregando mídias...',
  'library.loadingMore': 'Carregando mais...',
  'library.loadError': 'Não foi possível carregar a biblioteca.',
  'library.loadMoreError': 'Erro ao carregar mais mídias.',
  'library.cloudPending': 'No Google Drive: miniatura e duração são lidas quando o vídeo for aberto',
  'library.cloudLoad': 'Ler agora',
  'library.cloudLoading': 'Lendo...',
  'library.cloudLoadFailed': 'Tentar de novo',
  'library.countFound': '{total} mídias encontradas',
  'library.countOf': '{loaded} de {total} mídias',
  'library.favAdd': 'Favoritar',
  'library.favRemove': 'Remover dos favoritos',
  'library.select': 'Selecionar'
};

export function t(key, vars) {
  let s = STRINGS[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return s;
}
