require('dotenv').config();

module.exports = {
    apps: [
        {
            name: 'BackendBill',
            script: 'dist/index.js',
            env: {
                NODE_ENV: 'development'
            },
            env_production: {
                NODE_ENV: 'production',
                TWITCH_CLIENT_ID: process.env.PROD_TWITCH_CLIENT_ID,
                TWITCH_SECRET: process.env.PROD_TWITCH_SECRET,
                TEST_SECRET: process.env.PROD_TEST_SECRET,
                TWITCH_CALLBACK_URL: process.env.PROD_TWITCH_CALLBACK_URL,
                SESSION_SECRET: process.env.PROD_SESSION_SECRET,
                PROD_PORT: process.env.PROD_PORT
            }
        }
    ],
    deploy: {
        production: {
            user: 'ubuntu',
            host: 'ec2-3-231-208-118.compute-1.amazonaws.com',
            key: '~/.ssh/billbo-key.pem',
            ref: 'origin/main',
            repo: 'git@github.com:TahaBilalCS/BackendBill.git',
            path: '/home/ubuntu/BackendBill',
            // env: {}
            'post-deploy': 'npm install && npm run build && pm2 startOrRestart ecosystem.config.cjs --env production'
        }
    }
};
