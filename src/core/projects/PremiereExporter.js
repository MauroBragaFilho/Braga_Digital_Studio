const fs = require('fs');
const path = require('path');

class PremiereExporter {
    constructor(projectService) {
        this.projectService = projectService;
    }

    _generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    _escapeXml(unsafe) {
        if (!unsafe) return '';
        return unsafe.toString().replace(/[<>&'"]/g, function (c) {
            switch (c) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case '\'': return '&apos;';
                case '"': return '&quot;';
            }
        });
    }

    _buildBinXml(bin, allBins, allMedia) {
        // Find children bins
        const childrenBins = allBins.filter(b => b.parent_id === bin.id);
        // Find media in this bin
        const binMedia = allMedia.filter(m => m.bin_id === bin.id);

        let xml = `
            <bin>
                <name>${this._escapeXml(bin.name)}</name>
                <children>
`;
        
        // Render sub-bins
        for (const childBin of childrenBins) {
            xml += this._buildBinXml(childBin, allBins, allMedia);
        }

        // Render media clips
        for (const item of binMedia) {
            const clipId = `clip-${item.pm_id}`;
            const fileId = `file-${item.pm_id}`;
            // Convert to absolute file:// URL (FCP 7 XML spec)
            const filePathUrl = 'file://localhost/' + item.filepath.replace(/\\/g, '/').replace(/ /g, '%20');
            const itemName = item.custom_name || item.filename;

            xml += `
                <clip id="${clipId}">
                    <name>${this._escapeXml(itemName)}</name>
                    <duration>${Math.round((item.duration || 0) * (item.fps || 30))}</duration>
                    <rate>
                        <timebase>${Math.round(item.fps || 30)}</timebase>
                        <ntsc>${(item.fps || 30) % 1 !== 0 ? 'TRUE' : 'FALSE'}</ntsc>
                    </rate>
                    <media>
                        <video>
                            <track>
                                <clipitem id="${clipId}-video">
                                    <name>${this._escapeXml(itemName)}</name>
                                    <file id="${fileId}">
                                        <name>${this._escapeXml(itemName)}</name>
                                        <pathurl>${this._escapeXml(filePathUrl)}</pathurl>
                                    </file>
                                </clipitem>
                            </track>
                        </video>
                    </media>
                </clip>
`;
        }

        xml += `
                </children>
            </bin>
`;
        return xml;
    }

    exportToPremiereXml(projectId, outputPath) {
        const project = this.projectService.getProjectById(projectId);
        if (!project) throw new Error('Projeto não encontrado');

        const allBins = this.projectService.getProjectBins(projectId);
        const allMedia = this.projectService.getProjectMedia(projectId);

        // Root bins (no parent)
        const rootBins = allBins.filter(b => !b.parent_id);
        const rootMedia = allMedia.filter(m => !m.bin_id);

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <project>
    <name>${this._escapeXml(project.name)}</name>
    <children>
`;

        for (const rootBin of rootBins) {
            xml += this._buildBinXml(rootBin, allBins, allMedia);
        }

        for (const item of rootMedia) {
            const clipId = `clip-${item.pm_id}`;
            const fileId = `file-${item.pm_id}`;
            const filePathUrl = 'file://localhost/' + item.filepath.replace(/\\/g, '/').replace(/ /g, '%20');
            const itemName = item.custom_name || item.filename;

            xml += `
                <clip id="${clipId}">
                    <name>${this._escapeXml(itemName)}</name>
                    <file id="${fileId}">
                        <name>${this._escapeXml(itemName)}</name>
                        <pathurl>${this._escapeXml(filePathUrl)}</pathurl>
                    </file>
                </clip>
`;
        }

        xml += `
    </children>
  </project>
</xmeml>
`;

        fs.writeFileSync(outputPath, xml, 'utf8');
        return outputPath;
    }
}

module.exports = PremiereExporter;
