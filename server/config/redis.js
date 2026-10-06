import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let redis = null;
let redisPub = null;
let redisSub = null;
let ready = false;
let connecting = null;

const clientOptions = {
    url: REDIS_URL,
    socket: {
        reconnectStrategy: (retries) => {
            if (retries > 20) return 15_000;
            return Math.min(retries * 250, 5000);
        },
        connectTimeout: 8000
    }
};

const attachClientLogs = (client, label) => {
    client.on('error', (err) => {
        ready = false;
        console.error(`[Redis:${label}]`, err.message);
    });
    client.on('ready', () => {
        ready = true;
        console.log(`[Redis:${label}] ready`);
    });
    client.on('end', () => {
        ready = false;
    });
};

export const isRedisReady = () => ready && redis?.isOpen;

export const getRedis = () => redis;

export const getRedisPubSub = () => ({ pub: redisPub, sub: redisSub });

export const connectRedis = async () => {
    if (process.env.REDIS_ENABLED === 'false') {
        console.log('[Redis] disabled via REDIS_ENABLED=false');
        return { ready: false };
    }

    if (connecting) return connecting;

    connecting = (async () => {
        try {
            redis = createClient(clientOptions);
            redisPub = redis.duplicate();
            redisSub = redis.duplicate();

            attachClientLogs(redis, 'cache');
            attachClientLogs(redisPub, 'pub');
            attachClientLogs(redisSub, 'sub');

            await Promise.all([redis.connect(), redisPub.connect(), redisSub.connect()]);
            ready = true;
            console.log('[Redis] connected');
            return { ready: true };
        } catch (err) {
            ready = false;
            console.error('[Redis] connection failed — running without cache:', err.message);
            return { ready: false };
        }
    })();

    return connecting;
};

export const disconnectRedis = async () => {
    ready = false;
    await Promise.allSettled([
        redis?.quit(),
        redisPub?.quit(),
        redisSub?.quit()
    ]);
};
