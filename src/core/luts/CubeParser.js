'use strict';

const fs = require('node:fs');

/**
 * CubeParser — Leitura e interpretação de arquivos de LUT 3D (.cube).
 *
 * Suporta metadados (TITLE, LUT_3D_SIZE, DOMAIN_MIN, DOMAIN_MAX)
 * e trios RGB normalizados.
 */
class CubeParser {
  /**
   * Parse completo de um arquivo .cube.
   * @param {string} filePath - Caminho absoluto do arquivo .cube
   * @returns {Object} { size, data, title, domainMin, domainMax, headerLines, totalEntries, preview }
   */
  static parse(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);

    let size = null;
    let lutData = [];
    let title = null;
    let domainMin = null;
    let domainMax = null;
    const headerLines = [];

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (trimmedLine.startsWith('#') || trimmedLine === '') {
        if (trimmedLine !== '') headerLines.push(trimmedLine);
        continue;
      }

      if (trimmedLine.startsWith('TITLE')) {
        headerLines.push(trimmedLine);
        const titleMatch = trimmedLine.match(/TITLE\s+"?([^"]*)"?/);
        if (titleMatch) {
          title = titleMatch[1].trim();
        }
        continue;
      }

      if (trimmedLine.startsWith('LUT_3D_SIZE')) {
        headerLines.push(trimmedLine);
        const sizeMatch = trimmedLine.match(/LUT_3D_SIZE\s+(\d+)/);
        if (sizeMatch) {
          size = parseInt(sizeMatch[1], 10);
        }
        continue;
      }

      if (trimmedLine.startsWith('DOMAIN_MIN')) {
        headerLines.push(trimmedLine);
        const parts = trimmedLine.split(/\s+/).slice(1).map(parseFloat);
        if (parts.length === 3) domainMin = parts;
        continue;
      }

      if (trimmedLine.startsWith('DOMAIN_MAX')) {
        headerLines.push(trimmedLine);
        const parts = trimmedLine.split(/\s+/).slice(1).map(parseFloat);
        if (parts.length === 3) domainMax = parts;
        continue;
      }

      if (size && !isNaN(size)) {
        const rgbValues = trimmedLine.split(/\s+/).map(parseFloat);
        if (rgbValues.length === 3) {
          lutData.push(rgbValues);
        }
      }
    }

    if (!size || lutData.length === 0) {
      throw new Error('Formato de LUT inválido ou dados ausentes.');
    }

    if (lutData.length !== size * size * size) {
      throw new Error(`Número de entradas (${lutData.length}) não corresponde ao tamanho (${size}^3 = ${size * size * size})`);
    }

    return {
      size,
      data: lutData,
      title,
      domainMin,
      domainMax,
      headerLines,
      totalEntries: lutData.length,
      preview: lutData.slice(0, 100)
    };
  }

  /**
   * Parse apenas do cabeçalho/metadados (sem carregar a tabela inteira em memória).
   * @param {string} filePath - Caminho do arquivo .cube
   * @returns {Object} { title, size, domainMin, domainMax, headerLines, totalEntries, preview }
   */
  static parseHeader(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);

    let size = null;
    let title = null;
    let domainMin = null;
    let domainMax = null;
    const headerLines = [];
    const preview = [];
    const PREVIEW_LIMIT = 100;
    let totalEntries = 0;

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine === '') continue;

      if (trimmedLine.startsWith('#')) {
        headerLines.push(trimmedLine);
        continue;
      }

      if (trimmedLine.startsWith('TITLE')) {
        headerLines.push(trimmedLine);
        const titleMatch = trimmedLine.match(/TITLE\s+"?([^"]*)"?/);
        if (titleMatch) title = titleMatch[1].trim();
        continue;
      }

      if (trimmedLine.startsWith('LUT_3D_SIZE')) {
        headerLines.push(trimmedLine);
        const sizeMatch = trimmedLine.match(/LUT_3D_SIZE\s+(\d+)/);
        if (sizeMatch) size = parseInt(sizeMatch[1], 10);
        continue;
      }

      if (trimmedLine.startsWith('DOMAIN_MIN')) {
        headerLines.push(trimmedLine);
        const parts = trimmedLine.split(/\s+/).slice(1).map(parseFloat);
        if (parts.length === 3) domainMin = parts;
        continue;
      }

      if (trimmedLine.startsWith('DOMAIN_MAX')) {
        headerLines.push(trimmedLine);
        const parts = trimmedLine.split(/\s+/).slice(1).map(parseFloat);
        if (parts.length === 3) domainMax = parts;
        continue;
      }

      if (size && !isNaN(size)) {
        const rgbValues = trimmedLine.split(/\s+/).map(parseFloat);
        if (rgbValues.length === 3 && rgbValues.every(v => !isNaN(v))) {
          totalEntries++;
          if (preview.length < PREVIEW_LIMIT) {
            preview.push(rgbValues);
          }
        }
      }
    }

    return {
      title,
      size,
      domainMin,
      domainMax,
      headerLines,
      totalEntries,
      preview
    };
  }
}

module.exports = CubeParser;
