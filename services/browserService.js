const fs = require('fs');
const path = require('path');

function getPreferredBrowser() {

    const browsers = [
        {
            name: 'chrome',
            path: path.join(
                process.env.LOCALAPPDATA,
                'Google',
                'Chrome'
            )
        },
        {
            name: 'edge',
            path: path.join(
                process.env.LOCALAPPDATA,
                'Microsoft',
                'Edge'
            )
        },
        {
            name: 'brave',
            path: path.join(
                process.env.LOCALAPPDATA,
                'BraveSoftware',
                'Brave-Browser'
            )
        },
        {
            name: 'firefox',
            path: path.join(
                process.env.APPDATA,
                'Mozilla',
                'Firefox'
            )
        }
    ];

    const browser = browsers.find(
        item => fs.existsSync(item.path)
    );

    return browser?.name || null;
}

module.exports = {
    getPreferredBrowser
};