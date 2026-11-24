'use strict';
require('../../server/saas/tenant');
process.on('message', (m) => { if (m && m.type === 'test-hang') for (;;) ; });
