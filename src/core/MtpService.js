const { exec, spawn } = require('child_process');
const EventEmitter = require('events');
const path = require('path');
const logger = require('../services/logService');

// Helper script C# para interop WPD nativo (sem janela Shell.Application)
const wpdCSCode = `
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using PortableDeviceApiLib;
using PortableDeviceTypesLib;

namespace BmdWpdInterop
{
    public class WpdTransfer
    {
        private static readonly Guid WPD_OBJECT_DATE_CREATED = new Guid("4CD196E0-B770-4A2E-9785-321D28C77929");
        private static readonly Guid WPD_OBJECT_DATE_MODIFIED = new Guid("B68F4DCD-A4E2-4F9B-968D-8822C092985D");
        private static readonly Guid WPD_DEVICE_BATTERY_LEVEL = new Guid("F01B5F55-B1AE-4740-9576-9D4B32009A06");
        private static readonly Guid WPD_RESOURCE_DEFAULT = new Guid("E81E79BE-34F0-41BF-B53F-F1A06AE87842");

        private static PortableDeviceKeyCollection pKeys;
        private static PROPERTYKEY PK_NAME = new PROPERTYKEY { fmtid = new Guid("EF6B4EDD-55E6-4386-B924-9E9F9A6C60F7"), pid = 4 };
        private static PROPERTYKEY PK_SIZE = new PROPERTYKEY { fmtid = new Guid("EF6B4EDD-55E6-4386-B924-9E9F9A6C60F7"), pid = 11 };
        private static PROPERTYKEY PK_CONTENT_TYPE = new PROPERTYKEY { fmtid = new Guid("EF6B4EDD-55E6-4386-B924-9E9F9A6C60F7"), pid = 7 };
        private static PROPERTYKEY PK_DATE_MODIFIED = new PROPERTYKEY { fmtid = WPD_OBJECT_DATE_MODIFIED, pid = 2 };
        private static PROPERTYKEY PK_DATE_CREATED = new PROPERTYKEY { fmtid = WPD_OBJECT_DATE_CREATED, pid = 2 };
        private static PROPERTYKEY PK_BATTERY = new PROPERTYKEY { fmtid = WPD_DEVICE_BATTERY_LEVEL, pid = 2 };

        public static IPortableDeviceManager GetManager()
        {
            return (IPortableDeviceManager)new PortableDeviceManager();
        }

        public static string[] GetDeviceIDs()
        {
            var mgr = GetManager();
            uint count = 0;
            mgr.GetDevices(null, ref count);
            if (count == 0) return new string[0];

            string[] deviceIds = new string[count];
            mgr.GetDevices(deviceIds, ref count);
            return deviceIds;
        }

        public static string GetDeviceFriendlyName(IPortableDeviceManager mgr, string deviceId)
        {
            try
            {
                uint nameLen = 0;
                mgr.GetDeviceFriendlyName(deviceId, null, ref nameLen);
                if (nameLen == 0) return deviceId;
                ushort[] buffer = new ushort[nameLen];
                mgr.GetDeviceFriendlyName(deviceId, buffer, ref nameLen);
                return new string(Array.ConvertAll(buffer, c => (char)c)).TrimEnd('\\0');
            }
            catch
            {
                return deviceId;
            }
        }

        public static int? GetDeviceBattery(IPortableDevice device)
        {
            try
            {
                IPortableDeviceContent content;
                device.Content(out content);
                IPortableDeviceProperties props;
                content.Properties(out props);

                IPortableDeviceKeyCollection keys = (IPortableDeviceKeyCollection)new PortableDeviceKeyCollection();
                keys.Add(ref PK_BATTERY);

                IPortableDeviceValues values;
                props.GetValues("DEVICE", keys, out values);
                int level;
                values.GetUnsignedIntegerValue(ref PK_BATTERY, out uint uLevel);
                return (int)uLevel;
            }
            catch
            {
                return null;
            }
        }
    }
}
`;

class MtpService extends EventEmitter {
  /**
   * Executa um script PowerShell para listar dispositivos MTP conectados.
   * @returns {Promise<Array>} Lista de dispositivos MTP e seus armazenamentos.
   */
  async getDevices() {
    return new Promise((resolve, reject) => {
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
        $fileSize = [long]($targetItem.ExtendedProperty("System.Size"))
        
        $dateModified = $targetItem.ModifyDate
        $dateCreated = $targetItem.ExtendedProperty("System.DateCreated")
        $itemDate = $targetItem.ExtendedProperty("System.ItemDate")
        
        $destFilePath = Join-Path $destPath $itemName
        
        $stream = $null
        $outStream = $null
        $copiedSuccessfully = $false
        
        try {
            # Leitura direta via Stream nativo Shell / IStream para suprimir a janela nativa do Windows Explorer
            $stream = $targetItem.GetFolder.GetDetailsOf($targetItem, 0)
        } catch {}
        
        # Leitura via Buffer de arquivo (chunked copy sem CopyHere)
        try {
            $bufferSize = 1048576 # 1MB chunks
            $buffer = New-Object byte[] $bufferSize
            
            # Utiliza o FolderItem e acessa o stream de dados via Shell ou COM Stream
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
                    $progressObj = @{
                        file = $itemName
                        percent = $percent
                        currentSize = $totalRead
                        totalSize = $fileSize
                        speedBps = $speedBps
                    }
                    $progressJson = $progressObj | ConvertTo-Json -Compress
                    [Console]::Out.WriteLine($progressJson); [Console]::Out.Flush()
                }
                $outStream.Close()
                $sourceStream.Close()
                $copiedSuccessfully = $true
            }
        } catch {
            $copiedSuccessfully = $false
        }
        
        # Fallback para caso de streams restritos: Faz o CopyHere suprimindo diálogos o máximo possível
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
                        if ($bytesDiff -gt 0) {
                            $speedBps = [long]($bytesDiff / $elapsedSeconds)
                        }
                    }
                    $lastTime = $now
                    
                    $percent = if ($fileSize -gt 0) { [math]::Round(($currentSize / $fileSize) * 100) } else { 100 }
                    
                    $progressObj = @{
                        file = $itemName
                        percent = $percent
                        currentSize = $currentSize
                        totalSize = $fileSize
                        speedBps = $speedBps
                    }
                    $progressJson = $progressObj | ConvertTo-Json -Compress
                    [Console]::Out.WriteLine($progressJson); [Console]::Out.Flush()
                    
                    if ($currentSize -ge $fileSize) {
                        break
                    }
                    
                    if ($currentSize -eq $lastSize) {
                        $timeoutCount++
                        if ($timeoutCount -gt 50) {
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
        
        # Aplica a data original ao arquivo final no Windows
        if (Test-Path $destFilePath) {
            try {
                $fileObj = Get-Item $destFilePath
                $bestDate = $null
                if ($itemDate -ne $null) { $bestDate = $itemDate }
                elseif ($dateModified -ne $null) { $bestDate = $dateModified }
                elseif ($dateCreated -ne $null) { $bestDate = $dateCreated }
                
                if ($bestDate -ne $null) {
                    $fileObj.CreationTime = $bestDate
                    $fileObj.LastWriteTime = $bestDate
                }
            } catch {}
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
        stdoutData = lines.pop();
        
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

