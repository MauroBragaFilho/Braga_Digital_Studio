'use strict';

const { exec, spawn } = require('node:child_process');
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
      exec(
        `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`,
        { encoding: 'utf8' },
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
   * @param {string} deviceName
   * @param {string[]} pathArray
   * @returns {Promise<Array>}
   */
  async listFolder(deviceName, pathArray) {
    return new Promise((resolve) => {
      const pathStr = pathArray.map(p => `"${p.replace(/"/g, '""')}"`).join(',');
      const psScript = `
$shell = New-Object -ComObject Shell.Application
$computer = $shell.NameSpace(17)
$deviceName = "${deviceName}"
$pathArray = @(${pathStr})

$device = $computer.Items() | Where-Object { $_.Name -eq $deviceName -or $_.Name -match $deviceName } | Select-Object -First 1
if ($device -eq $null) { exit }

$currentFolder = $device.GetFolder
foreach ($p in $pathArray) {
    if ($p -ne "") {
        $found = $currentFolder.Items() | Where-Object { $_.Name -eq $p -or $_.Name -match $p } | Select-Object -First 1
        if ($found -eq $null) { exit }
        $currentFolder = $found.GetFolder
    }
}

$results = @()
foreach ($item in $currentFolder.Items()) {
    $results += @{
        Name = $item.Name
        IsFolder = $item.IsFolder
        Size = $item.ExtendedProperty("System.Size")
    }
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$results | ConvertTo-Json -Depth 5
      `;
      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
      exec(
        `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`,
        { encoding: 'utf8' },
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
   * Importa arquivos MTP para destino local com progresso via IPC/events.
   * @param {string} deviceName
   * @param {string[]} pathArray
   * @param {string[]} itemNames
   * @param {string} destFolder
   * @returns {Promise<boolean>}
   */
  async importItems(deviceName, pathArray, itemNames, destFolder) {
    return new Promise((resolve) => {
      const pathStr = pathArray.map(p => `"${p.replace(/"/g, '""')}"`).join(',');
      const itemsStr = itemNames.map(n => `"${n.replace(/"/g, '""')}"`).join(',');

      const psScript = `
$shell = New-Object -ComObject Shell.Application
$computer = $shell.NameSpace(17)
$deviceName = "${deviceName}"
$pathArray = @(${pathStr})
$itemNames = @(${itemsStr})
$destPath = "${destFolder}"

New-Item -ItemType Directory -Force -Path $destPath | Out-Null
$destFolderObj = $shell.NameSpace($destPath)

$device = $computer.Items() | Where-Object { $_.Name -eq $deviceName -or $_.Name -match $deviceName } | Select-Object -First 1
if ($device -eq $null) { exit }

$currentFolder = $device.GetFolder
foreach ($p in $pathArray) {
    if ($p -ne "") {
        $found = $currentFolder.Items() | Where-Object { $_.Name -eq $p -or $_.Name -match $p } | Select-Object -First 1
        if ($found -eq $null) { exit }
        $currentFolder = $found.GetFolder
    }
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

foreach ($itemName in $itemNames) {
    $targetItem = $currentFolder.Items() | Where-Object { $_.Name -eq $itemName -or $_.Name -match $itemName } | Select-Object -First 1
    if ($targetItem -ne $null) {
        $fileSize = [long]($targetItem.ExtendedProperty("System.Size"))
        $dateModified = $targetItem.ModifyDate
        $dateCreated = $targetItem.ExtendedProperty("System.DateCreated")
        $itemDate = $targetItem.ExtendedProperty("System.ItemDate")
        $destFilePath = Join-Path $destPath $itemName
        $copiedSuccessfully = $false

        try {
            $bufferSize = 1048576
            $buffer = New-Object byte[] $bufferSize
            $sourceStream = $null
            if ($targetItem.PSObject.Properties['Open']) {
                $sourceStream = $targetItem.Open()
            }
            if ($sourceStream -ne $null) {
                $outStream = [System.IO.File]::Create($destFilePath)
                $totalRead = 0L
                $lastTime = [System.DateTime]::Now
                $lastRead = 0L
                while (($read = $sourceStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $outStream.Write($buffer, 0, $read)
                    $totalRead += $read
                    $now = [System.DateTime]::Now
                    $elapsedSeconds = ($now - $lastTime).TotalSeconds
                    $speedBps = 0
                    if ($elapsedSeconds -ge 0.2) {
                        $bytesSinceLast = $totalRead - $lastRead
                        $speedBps = [long]($bytesSinceLast / $elapsedSeconds)
                        $lastTime = $now
                        $lastRead = $totalRead
                    }
                    $percent = if ($fileSize -gt 0) { [math]::Round(($totalRead / $fileSize) * 100) } else { 100 }
                    $progressObj = @{ file = $itemName; percent = $percent; currentSize = $totalRead; totalSize = $fileSize; speedBps = $speedBps }
                    [Console]::Out.WriteLine($progressObj | ConvertTo-Json -Compress); [Console]::Out.Flush()
                }
                $outStream.Close()
                $sourceStream.Close()
                $copiedSuccessfully = $true
            }
        } catch { $copiedSuccessfully = $false }

        if (-not $copiedSuccessfully) {
            $destFolderObj.CopyHere($targetItem, 1044)
            $timeoutCount = 0
            $lastSize = -1
            $lastTime = [System.DateTime]::Now
            while ($true) {
                Start-Sleep -Milliseconds 200
                if (Test-Path $destFilePath) {
                    $currentSize = (Get-Item $destFilePath).Length
                    $now = [System.DateTime]::Now
                    $elapsedSeconds = ($now - $lastTime).TotalSeconds
                    $speedBps = 0
                    if ($elapsedSeconds -gt 0 -and $lastSize -ge 0) {
                        $bytesDiff = $currentSize - $lastSize
                        if ($bytesDiff -gt 0) { $speedBps = [long]($bytesDiff / $elapsedSeconds) }
                    }
                    $lastTime = $now
                    $percent = if ($fileSize -gt 0) { [math]::Round(($currentSize / $fileSize) * 100) } else { 100 }
                    $progressObj = @{ file = $itemName; percent = $percent; currentSize = $currentSize; totalSize = $fileSize; speedBps = $speedBps }
                    [Console]::Out.WriteLine($progressObj | ConvertTo-Json -Compress); [Console]::Out.Flush()
                    if ($currentSize -ge $fileSize) { break }
                    if ($currentSize -eq $lastSize) {
                        $timeoutCount++
                        if ($timeoutCount -gt 50) { [Console]::Out.WriteLine('{"error":"Timeout on ' + $itemName + '"}'); [Console]::Out.Flush(); break }
                    } else { $timeoutCount = 0; $lastSize = $currentSize }
                } else {
                    $timeoutCount++
                    if ($timeoutCount -gt 50) { [Console]::Out.WriteLine('{"error":"Timeout waiting ' + $itemName + '"}'); [Console]::Out.Flush(); break }
                }
            }
        }

        if (Test-Path $destFilePath) {
            try {
                $fileObj = Get-Item $destFilePath
                $bestDate = $null
                if ($itemDate -ne $null) { $bestDate = $itemDate }
                elseif ($dateModified -ne $null) { $bestDate = $dateModified }
                elseif ($dateCreated -ne $null) { $bestDate = $dateCreated }
                if ($bestDate -ne $null) { $fileObj.CreationTime = $bestDate; $fileObj.LastWriteTime = $bestDate }
            } catch {}
        }
    }
}
      `;

      const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-']);

      let stdoutBuffer = '';
      ps.stdout.on('data', (data) => {
        const text = data.toString('utf8');
        stdoutBuffer += text;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop();
        for (let line of lines) {
          line = line.trim();
          if (line.startsWith('{')) {
            try {
              const obj = JSON.parse(line);
              if (obj.error) {
                logger.error('WindowsMtpProvider:importItems:script_error', { error: obj.error });
              } else {
                this.emit('progress', obj);
              }
            } catch (_) {}
          }
        }
      });

      ps.stderr.on('data', (data) => {
        logger.error('WindowsMtpProvider:importItems:stderr', { msg: data.toString() });
      });

      ps.on('close', (code) => resolve(code === 0));

      ps.stdin.write(psScript);
      ps.stdin.end();
    });
  }
}

module.exports = { WindowsMtpProvider };
