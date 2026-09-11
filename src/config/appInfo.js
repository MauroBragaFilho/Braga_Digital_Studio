'use strict';

/**
 * appInfo — Constantes de identidade da aplicação, usadas em mais de um módulo.
 *
 * Centraliza aqui em vez de repetir strings soltas pelo código (ex: developerEmail
 * aparecia hardcoded em 4 arquivos diferentes: SettingsManager, ErrorReporter x2,
 * bootstrap.js). Qualquer mudança de contato/branding passa a ser feita em um único lugar.
 */
module.exports = {
  /** E-mail padrão do desenvolvedor, usado como destino de relatórios de erro (mailto:)
   *  e como valor default de `developerEmail` nas configurações do usuário. */
  DEVELOPER_EMAIL: 'obragafilho00@gmail.com'
};
