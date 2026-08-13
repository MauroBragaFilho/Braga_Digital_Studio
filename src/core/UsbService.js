const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const logger = require('../../services/logService');

class UsbService extends EventEmitter {
  /**
   * Retrieves a list of USB removable drives.
   */
  async getDevices() {
    return new Promise((resolve) => {
      const psScript = `
$disks = Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 -and $_.VolumeName -ne "PMHOME" }
$results = @()
foreach ($disk in $disks) {
    $results += @{
        id = $disk.DeviceID
        name = if ($disk.VolumeName) { $disk.VolumeName } else { "Unidade USB ($($disk.DeviceID))" }
        capacity = $disk.Size
        free = $disk.FreeSpace
        type = "usb"
        path = "$($disk.DeviceID)\\"
    }
}
$results | ConvertTo-Json -Compress
      `;
      
      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
      exec(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`, { encoding: 'utf8' }, (error, stdout) => {
        if (error) {
          logger.error('Error getting USB devices:', error);
          return resolve([]);
        }

        try {
          const str = stdout.trim();
          if (!str) return resolve([]);
          
          let parsed = JSON.parse(str);
          if (!Array.isArray(parsed)) {
            parsed = [parsed];
          }

          const devices = parsed.map(disk => ({
            id: disk.id,
            name: disk.name,
            type: 'usb',
            storage: [{
              name: 'Mass Storage',
              path: disk.path,
              capacity: disk.capacity || 0,
              free: disk.free || 0
            }]
          }));

          resolve(devices);
        } catch (err) {
          logger.error('Error parsing USB devices JSON:', err);
          resolve([]);
        }
      });
    });
  }

  /**
   * Lists the contents of a USB folder.
   */
  async listFolder(basePath, pathArray) {
    return new Promise((resolve) => {
      try {
        let currentPath = basePath;
        for (const p of pathArray) {
          if (p) currentPath = path.join(currentPath, p);
        }

        if (!fs.existsSync(currentPath)) {
          return resolve({ success: false, items: [] });
        }

        const items = [];
        const dirEntries = fs.readdirSync(currentPath, { withFileTypes: true });

        for (const entry of dirEntries) {
          // Ignore system files and specified folders
          const nLower = entry.name.toLowerCase();
          const ignored = ['system volume information', 'info', 'mp_root', 'pmcademo', 'tweaklog.txt', 'avf_info'];
          
          if (entry.name.startsWith('$') || ignored.includes(nLower)) {
            continue;
          }

          let size = 0;
          if (entry.isFile()) {
            size = fs.statSync(path.join(currentPath, entry.name)).size;
          }

          items.push({
            name: entry.name,
            isFolder: entry.isDirectory(),
            size: size
          });
        }

        resolve({ success: true, items });
      } catch (err) {
        logger.error('Error listing USB folder:', err);
        resolve({ success: false, items: [] });
      }
    });
  }

  /**
   * Copies items from USB to local disk with progress tracking.
   */
  async importItems(basePath, pathArray, itemNames, destFolder) {
    return new Promise(async (resolve) => {
      try {
        if (!fs.existsSync(destFolder)) {
          fs.mkdirSync(destFolder, { recursive: true });
        }

        let currentPath = basePath;
        for (const p of pathArray) {
          if (p) currentPath = path.join(currentPath, p);
        }

        for (const itemName of itemNames) {
          const sourceFile = path.join(currentPath, itemName);
          const destFile = path.join(destFolder, itemName);

          if (!fs.existsSync(sourceFile)) continue;
          
          const stat = fs.statSync(sourceFile);
          if (stat.isDirectory()) continue; // We only support flat files for now, or we'd need recursive copy

          const totalSize = stat.size;
          let copiedSize = 0;

          await new Promise((resCopy) => {
            const readStream = fs.createReadStream(sourceFile);
            const writeStream = fs.createWriteStream(destFile);
            
            let lastUpdate = Date.now();

            readStream.on('data', (chunk) => {
              copiedSize += chunk.length;
              
              const now = Date.now();
              // Emit progress every 150ms to avoid flooding IPC
              if (now - lastUpdate > 150 || copiedSize === totalSize) {
                lastUpdate = now;
                const percent = totalSize > 0 ? Math.round((copiedSize / totalSize) * 100) : 100;
                this.emit('progress', {
                  file: itemName,
                  percent: percent,
                  currentSize: copiedSize,
                  totalSize: totalSize,
                  type: 'usb'
                });
              }
            });

            writeStream.on('finish', () => {
              resCopy();
            });

            readStream.on('error', (err) => {
              logger.error('Read error on ' + itemName, err);
              resCopy();
            });
            writeStream.on('error', (err) => {
              logger.error('Write error on ' + itemName, err);
              resCopy();
            });

            readStream.pipe(writeStream);
          });
        }

        resolve(true);
      } catch (err) {
        logger.error('Error importing USB items:', err);
        resolve(false);
      }
    });
  }
}

module.exports = new UsbService();
