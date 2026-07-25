const { exec, spawn } = require('child_process');
const EventEmitter = require('events');
const path = require('path');
const logger = require('../../services/logService');

class MtpService extends EventEmitter {
  /**
   * Executa um script PowerShell para listar dispositivos MTP conectados (ex: Câmeras, Celulares).
   * @returns {Promise<Array>} Lista de dispositivos MTP e seus armazenamentos.
   */
  async getDevices() {
    return new Promise((resolve, reject) => {
      const psScript = `
$shell = New-Object -ComObject Shell.Application
$computer = $shell.NameSpace(17)
$devices = @()

foreach ($item in $computer.Items()) {
    if ($item.Type -match 'Digital Camera' -or $item.Type -match 'Portable Device' -or $item.Type -match 'Dispositivo Portátil' -or $item.Type -match 'Câmera Digital') {
        $storageItems = @()
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
            Storages = $storageItems
        }
    }
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$devices | ConvertTo-Json -Depth 5
      `;

      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');

      exec(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`, { encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          logger.error('Erro ao buscar dispositivos MTP via PowerShell:', error);
          return resolve([]);
        }
        
        try {
          const output = stdout.trim();
          if (!output) return resolve([]);
          
          let parsed = JSON.parse(output);
          if (!Array.isArray(parsed)) parsed = [parsed];
          resolve(parsed);
        } catch (e) {
          logger.error('Erro ao fazer o parse do JSON do MTP:', e);
          logger.error('Output original:', stdout);
          resolve([]);
        }
      });
    });
  }

  async listMtpFolder(deviceName, pathArray) {
    return new Promise((resolve, reject) => {
      // Serialize array for PowerShell
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

      exec(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`, { encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          logger.error('Erro ao listar pasta MTP via PowerShell:', error);
          return resolve([]);
        }
        try {
          const output = stdout.trim();
          if (!output) return resolve([]);
          let parsed = JSON.parse(output);
          if (!Array.isArray(parsed)) parsed = [parsed];
          resolve(parsed);
        } catch (e) {
          logger.error('Erro ao fazer o parse do JSON de pasta MTP:', e);
          resolve([]);
        }
      });
    });
  }

  async importMtpItems(deviceName, pathArray, itemNames, destFolder) {
    return new Promise((resolve, reject) => {
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
        $fileSize = $targetItem.ExtendedProperty("System.Size")
        $destFilePath = Join-Path $destPath $itemName
        
        # Inicia a cópia silenciosa (4 = No UI, 16 = Yes to All, 512 = Do not confirm mkdir, 1024 = No error UI)
        # 4 + 16 = 20
        $destFolderObj.CopyHere($targetItem, 1044)
        
        $timeoutCount = 0
        $lastSize = -1
        
        while ($true) {
            Start-Sleep -Milliseconds 200
            if (Test-Path $destFilePath) {
                $currentSize = (Get-Item $destFilePath).Length
                $percent = if ($fileSize -gt 0) { [math]::Round(($currentSize / $fileSize) * 100) } else { 100 }
                
                $progressObj = @{
                    file = $itemName
                    percent = $percent
                    currentSize = $currentSize
                    totalSize = $fileSize
                }
                $progressJson = $progressObj | ConvertTo-Json -Compress
                [Console]::Out.WriteLine($progressJson); [Console]::Out.Flush()
                
                if ($currentSize -ge $fileSize) {
                    break
                }
                
                if ($currentSize -eq $lastSize) {
                    $timeoutCount++
                    if ($timeoutCount -gt 50) { # 10 seconds timeout without progress
                        [Console]::Out.WriteLine("{""error"": ""Timeout on " + $itemName + """}"); [Console]::Out.Flush()
                        break
                    }
                } else {
                    $timeoutCount = 0
                    $lastSize = $currentSize
                }
            } else {
                $timeoutCount++
                if ($timeoutCount -gt 50) {
                    [Console]::Out.WriteLine("{""error"": ""Timeout waiting for file creation " + $itemName + """}"); [Console]::Out.Flush()
                    break
                }
            }
        }
    }
}
      `;

      const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-']);
      
      let stdoutData = '';
      ps.stdout.on('data', (data) => {
        const text = data.toString('utf8');
        stdoutData += text;
        const lines = stdoutData.split('\n');
        stdoutData = lines.pop(); // Keep the incomplete line
        
        for (let line of lines) {
          line = line.trim();
          if (line.startsWith('{')) {
            try {
              const obj = JSON.parse(line);
              if (obj.error) {
                logger.error('MTP Import Script Error:', obj.error);
              } else {
                this.emit('progress', obj);
              }
            } catch(e) {}
          }
        }
      });

      ps.stderr.on('data', (data) => {
        logger.error('PowerShell stderr:', data.toString());
      });

      ps.on('close', (code) => {
        resolve(code === 0);
      });

      ps.stdin.write(psScript);
      ps.stdin.end();
    });
  }
}

module.exports = new MtpService();
