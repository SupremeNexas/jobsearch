const { main } = require('./server');

main().catch(err => {
    console.error('Job application server failed to initialize:', err);
    process.exit(1);
});
