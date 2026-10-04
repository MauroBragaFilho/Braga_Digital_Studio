'use strict';

const { spawn } = require('node:child_process');
const { execOffThread } = require('../offThreadExec'); // criação do powershell fora do processo principal
const { StorageProvider } = require('../StorageProvider');
const logger = require('../../../services/logService');

/**
 * WindowsMtpProvider — Implementacao Windows-only do provider MTP.
 *
 * Encapsula TODA a logica de PowerShell / Shell.Application para interacao com
 * dispositivos MTP (cameras, smartphones) no Windows.
 *
 * Regra do roadmap (Sprint 5):
 *   Nenhum arquivo fora de src/infrastructure/hardware/windows/ deve conter
 *   chamadas a powershell.exe para dispositivos MTP.
 */
class WindowsMtpProvider extends StorageProvider {
  /**
   * Lista dispositivos MTP conectados via Shell.Application COM.
   * @returns {Promise<Array>}
   */
  async getDevices() {
    return new Promise((resolve) => {
      const psScript = `
$shell = New-Object -ComObject Shell.Application
$computer = $shell.NameSpace(17)
$devices = @()

foreach ($item in $computer.Items()) {
    if ($item.Path -notmatch '^[a-zA-Z]:\\\\?$' -and $item.Type -notmatch 'Network|Rede|System|Sistema') {
        $storageItems = @()
        $battery = $item.ExtendedProperty("System.BatteryPercentage")
        
        if ($item.GetFolder -ne $null) {
            foreach ($subItem in $item.GetFolder.Items()) {
                $size = $subItem.ExtendedProperty("System.Capacity")
                $free = $subItem.ExtendedProperty("System.FreeSpace")
                $storageItems += @{
                    Name = $subItem.Name
                    TotalSize = $size
                    FreeSpace = $free
                }
            }
        }
        $devices += @{
            Name = $item.Name
            Type = $item.Type
            BatteryLevel = $battery
            Storages = $storageItems
        }
    }
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$devices | ConvertTo-Json -Depth 5
      `;

      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
      execOffThread(
        `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`,
        { encoding: 'utf8', timeout: 8000, windowsHide: true },
        (error, stdout) => {
          if (error) {
            logger.error('WindowsMtpProvider:getDevices:error', { error: error.message });
            return resolve([]);
          }
          try {
            const output = stdout.trim();
            if (!output) return resolve([]);
            let parsed = JSON.parse(output);
            if (!Array.isArray(parsed)) parsed = [parsed];
            resolve(parsed);
          } catch (e) {
            logger.error('WindowsMtpProvider:getDevices:parse_error', { error: e.message });
            resolve([]);
          }
        }
      );
    });
  }

  /**
   * Lista o conteudo de uma pasta MTP.
   * Os dados (nome do dispositivo e caminho) vão para o PowerShell em JSON/base64 numa variável de ambiente:
   * nunca são interpolados no texto do script (sem injeção de comandos).
   * @param {string} deviceName
   * @param {string[]} pathArray
   * @returns {Promise<Array>}
   */
  async listFolder(deviceName, pathArray) {
    return new Promise((resolve) => {
      const args = encodeArgs({ deviceName: String(deviceName || ''), pathArray: cleanSegments(pathArray) });
      const encodedCommand = Buffer.from(LIST_SCRIPT, 'utf16le').toString('base64');
      execOffThread(
        `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`,
        { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, BDS_MTP_ARGS: args } },
        (error, stdout) => {
          if (error) {
            logger.error('WindowsMtpProvider:listFolder:error', { error: error.message });
            return resolve([]);
          }
          try {
            const output = stdout.trim();
            if (!output) return resolve([]);
            let parsed = JSON.parse(output);
            if (!Array.isArray(parsed)) parsed = [parsed];
            resolve(parsed);
          } catch (e) {
            logger.error('WindowsMtpProvider:listFolder:parse_error', { error: e.message });
            resolve([]);
          }
        }
      );
    });
  }

  /**
   * Importa arquivos MTP para destino local com progresso via eventos.
   * Nunca sobrescreve: mesmo nome e tamanho = já importado (pula); mesmo nome com tamanho diferente = "nome (2).ext".
   * Copia para ".part" e só renomeia ao fechar com o tamanho certo.
   * Resolve `false` se o dispositivo/pasta não foi encontrado ou se qualquer arquivo falhou.
   * @param {string} deviceName
   * @param {string[]} pathArray
   * @param {string[]} itemNames
   * @param {string} destFolder
   * @returns {Promise<boolean>}
   */
  async importItems(deviceName, pathArray, itemNames, destFolder) {
    return new Promise((resolve) => {
      const args = encodeArgs({
        deviceName: String(deviceName || ''),
        pathArray: cleanSegments(pathArray),
        itemNames: cleanSegments(itemNames),
        destPath: String(destFolder || ''),
      });
      const encodedCommand = Buffer.from(IMPORT_SCRIPT, 'utf16le').toString('base64');
      const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand], {
        windowsHide: true,
        env: { ...process.env, BDS_MTP_ARGS: args },
      });

      let stdoutBuffer = '';
      ps.stdout.on('data', (data) => {
        stdoutBuffer += data.toString('utf8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop();
        for (let line of lines) {
          line = line.trim();
          if (!line.startsWith('{')) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.error) {
              logger.error('WindowsMtpProvider:importItems:script_error', { error: obj.error });
            } else {
              this.emit('progress', obj);
            }
          } catch (_) { /* linha parcial */ }
        }
      });

      ps.stderr.on('data', (data) => {
        logger.error('WindowsMtpProvider:importItems:stderr', { msg: data.toString() });
      });

      ps.on('error', (err) => {
        logger.error('WindowsMtpProvider:importItems:spawn_error', { error: err.message });
        resolve(false);
      });
      ps.on('close', (code) => resolve(code === 0));
    });
  }
}

/** Remove segmentos vazios e qualquer coisa que não seja texto. */
function cleanSegments(list) {
  return (Array.isArray(list) ? list : []).filter((s) => typeof s === 'string' && s !== '');
}

function encodeArgs(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

// Trecho comum: lê os argumentos (JSON em base64) e navega até a pasta. Comparação sempre exata (-eq).
const PS_NAVIGATE = `
$cfg = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BDS_MTP_ARGS)) | ConvertFrom-Json
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$computer = $shell.NameSpace(17)
$deviceName = [string]$cfg.deviceName
$pathArray = @($cfg.pathArray)

$device = $computer.Items() | Where-Object { $_.Name -eq $deviceName } | Select-Object -First 1
if ($device -eq $null) { [Console]::Error.WriteLine('Dispositivo nao encontrado'); exit 2 }

$currentFolder = $device.GetFolder
foreach ($p in $pathArray) {
    $found = $currentFolder.Items() | Where-Object { $_.Name -eq $p } | Select-Object -First 1
    if ($found -eq $null) { [Console]::Error.WriteLine('Pasta nao encontrada'); exit 2 }
    $currentFolder = $found.GetFolder
}
`;

const LIST_SCRIPT = `${PS_NAVIGATE}
$results = @()
foreach ($item in $currentFolder.Items()) {
    $results += @{
        Name = $item.Name
        IsFolder = $item.IsFolder
        Size = $item.ExtendedProperty("System.Size")
    }
}
$results | ConvertTo-Json -Depth 5
`;

const IMPORT_SCRIPT = `${PS_NAVIGATE}
$itemNames = @($cfg.itemNames)
$destPath = [string]$cfg.destPath
New-Item -ItemType Directory -Force -Path $destPath | Out-Null
$failed = $false

function Get-UniquePath($dir, $name) {
    $base = [System.IO.Path]::GetFileNameWithoutExtension($name)
    $ext = [System.IO.Path]::GetExtension($name)
    $candidate = Join-Path $dir $name
    $n = 2
    while (Test-Path -LiteralPath $candidate) {
        $candidate = Join-Path $dir ("{0} ({1}){2}" -f $base, $n, $ext)
        $n++
    }
    return $candidate
}

function Send-Progress($file, $percent, $current, $total, $speed) {
    $o = @{ file = $file; percent = $percent; currentSize = $current; totalSize = $total; speedBps = $speed }
    [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush()
}

foreach ($itemName in $itemNames) {
    $targetItem = $currentFolder.Items() | Where-Object { $_.Name -eq $itemName } | Select-Object -First 1
    if ($targetItem -eq $null) {
        [Console]::Out.WriteLine((@{ error = ('Item nao encontrado: ' + $itemName) } | ConvertTo-Json -Compress)); [Console]::Out.Flush()
        $failed = $true
        continue
    }

    $fileSize = [long]($targetItem.ExtendedProperty("System.Size"))
    $dateModified = $targetItem.ModifyDate
    $dateCreated = $targetItem.ExtendedProperty("System.DateCreated")
    $itemDate = $targetItem.ExtendedProperty("System.ItemDate")
    $safeName = [System.IO.Path]::GetFileName($itemName)

    $finalPath = Join-Path $destPath $safeName
    if (Test-Path -LiteralPath $finalPath) {
        if ($fileSize -gt 0 -and (Get-Item -LiteralPath $finalPath).Length -eq $fileSize) {
            Send-Progress $itemName 100 $fileSize $fileSize 0
            continue
        }
        $finalPath = Get-UniquePath $destPath $safeName
    }
    $partPath = $finalPath + '.part'
    $copiedSuccessfully = $false
    $sourceStream = $null
    $outStream = $null

    try {
        if ($targetItem.PSObject.Properties['Open']) { $sourceStream = $targetItem.Open() }
        if ($sourceStream -ne $null) {
            $buffer = New-Object byte[] 1048576
            $outStream = [System.IO.File]::Create($partPath)
            $totalRead = 0L
            $lastTime = [System.DateTime]::Now
            $lastRead = 0L
            $speedBps = 0
            while (($read = $sourceStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $outStream.Write($buffer, 0, $read)
                $totalRead += $read
                $now = [System.DateTime]::Now
                $elapsedSeconds = ($now - $lastTime).TotalSeconds
                if ($elapsedSeconds -ge 0.2) {
                    $speedBps = [long](($totalRead - $lastRead) / $elapsedSeconds)
                    $lastTime = $now
                    $lastRead = $totalRead
                }
                $percent = if ($fileSize -gt 0) { [math]::Round(($totalRead / $fileSize) * 100) } else { 100 }
                Send-Progress $itemName $percent $totalRead $fileSize $speedBps
            }
            $outStream.Close(); $outStream = $null
            $sourceStream.Close(); $sourceStream = $null
            $copiedSuccessfully = $true
        }
    } catch { $copiedSuccessfully = $false }
    finally {
        if ($outStream -ne $null) { try { $outStream.Close() } catch {} }
        if ($sourceStream -ne $null) { try { $sourceStream.Close() } catch {} }
    }

    if (-not $copiedSuccessfully) {
        if (Test-Path -LiteralPath $partPath) { Remove-Item -LiteralPath $partPath -Force -ErrorAction SilentlyContinue }
        # Plano B (cópia pelo Explorer): numa subpasta temporária, para o Explorer não sobrescrever nada
        $tmpDir = Join-Path $destPath ('.bds-tmp-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
        $tmpObj = $shell.NameSpace($tmpDir)
        $tmpObj.CopyHere($targetItem, 1044)
        $tmpFile = Join-Path $tmpDir $targetItem.Name
        $timeoutCount = 0
        $lastSize = -1
        $lastTime = [System.DateTime]::Now
        while ($true) {
            Start-Sleep -Milliseconds 200
            if (Test-Path -LiteralPath $tmpFile) {
                $currentSize = (Get-Item -LiteralPath $tmpFile).Length
                $now = [System.DateTime]::Now
                $elapsedSeconds = ($now - $lastTime).TotalSeconds
                $speedBps = 0
                if ($elapsedSeconds -gt 0 -and $lastSize -ge 0 -and ($currentSize - $lastSize) -gt 0) { $speedBps = [long](($currentSize - $lastSize) / $elapsedSeconds) }
                $lastTime = $now
                $percent = if ($fileSize -gt 0) { [math]::Round(($currentSize / $fileSize) * 100) } else { 100 }
                Send-Progress $itemName $percent $currentSize $fileSize $speedBps
                if ($currentSize -ge $fileSize) { Start-Sleep -Milliseconds 300; break }
                if ($currentSize -eq $lastSize) {
                    $timeoutCount++
                    if ($timeoutCount -gt 50) { break }
                } else { $timeoutCount = 0; $lastSize = $currentSize }
            } else {
                $timeoutCount++
                if ($timeoutCount -gt 50) { break }
            }
        }
        if ((Test-Path -LiteralPath $tmpFile) -and ((Get-Item -LiteralPath $tmpFile).Length -eq $fileSize -or $fileSize -eq 0)) {
            Move-Item -LiteralPath $tmpFile -Destination $partPath -Force
            $copiedSuccessfully = $true
        }
        Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($copiedSuccessfully -and $fileSize -gt 0 -and (Get-Item -LiteralPath $partPath).Length -ne $fileSize) { $copiedSuccessfully = $false }

    if (-not $copiedSuccessfully) {
        if (Test-Path -LiteralPath $partPath) { Remove-Item -LiteralPath $partPath -Force -ErrorAction SilentlyContinue }
        [Console]::Out.WriteLine((@{ error = ('Falha ao copiar: ' + $itemName) } | ConvertTo-Json -Compress)); [Console]::Out.Flush()
        $failed = $true
        continue
    }

    Move-Item -LiteralPath $partPath -Destination $finalPath
    try {
        $fileObj = Get-Item -LiteralPath $finalPath
        $bestDate = $null
        if ($itemDate -ne $null) { $bestDate = $itemDate }
        elseif ($dateModified -ne $null) { $bestDate = $dateModified }
        elseif ($dateCreated -ne $null) { $bestDate = $dateCreated }
        if ($bestDate -ne $null) { $fileObj.CreationTime = $bestDate; $fileObj.LastWriteTime = $bestDate }
    } catch {}
}
if ($failed) { exit 1 }
`;

module.exports = { WindowsMtpProvider };
