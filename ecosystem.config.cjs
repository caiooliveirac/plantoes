module.exports = {
    apps: [
        {
            name: "plantoes",
            cwd: "/home/ubuntu/plantoes",
            env_file: "/home/ubuntu/plantoes/.env.production",
            script: "npm",
            args: "start",
            env: {
                NODE_ENV: "production",
                PORT: 3004,
                RUNTIME_SOURCE_OF_TRUTH: "pm2",
                TELEGRAM_DELIVERY_MODE: "webhook",
                GIT_COMMIT_SHA: process.env.GIT_COMMIT_SHA || "unknown",
                GIT_COMMIT_SHA_LONG: process.env.GIT_COMMIT_SHA_LONG || "unknown",
                GIT_WORKING_TREE_CLEAN: process.env.GIT_WORKING_TREE_CLEAN || "unknown",
            },
        },
        {
            name: "plantoes-telegram-worker",
            cwd: "/home/ubuntu/plantoes",
            env_file: "/home/ubuntu/plantoes/.env.production",
            script: "npm",
            args: "run telegram:worker",
            env: {
                NODE_ENV: "production",
                RUNTIME_SOURCE_OF_TRUTH: "pm2",
                TELEGRAM_DELIVERY_MODE: "webhook",
                GIT_COMMIT_SHA: process.env.GIT_COMMIT_SHA || "unknown",
                GIT_COMMIT_SHA_LONG: process.env.GIT_COMMIT_SHA_LONG || "unknown",
                GIT_WORKING_TREE_CLEAN: process.env.GIT_WORKING_TREE_CLEAN || "unknown",
            },
        },
    ],
};