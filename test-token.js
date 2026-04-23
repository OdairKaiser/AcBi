const http = require('http');

const options = {
    hostname: 'localhost',
    port: 4000,
    path: '/api/powerbi/embed-token?reportKey=ExtratosBancarios',
    method: 'GET'
};

const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        console.log('STATUS_CODE: ' + res.statusCode);
        try {
            const json = JSON.parse(data);
            if (json.accessToken) {
                console.log('✓ TOKEN_SUCCESS');
                console.log('reportId: ' + (json.reportId || 'N/A'));
                console.log('hasAccessToken: true');
                console.log('expiresAt: ' + (json.expiresAt || 'N/A'));
            } else if (json.details) {
                console.log('✗ ERROR_DETAILS: ' + json.details);
            } else {
                console.log('response: ' + JSON.stringify(json));
            }
        } catch (e) {
            console.log('PARSE_ERROR: ' + e.message);
            console.log('RESPONSE_BODY: ' + data);
        }
    });
});

req.on('error', (e) => {
    console.log('REQUEST_ERROR: ' + e.message);
});

req.end();
