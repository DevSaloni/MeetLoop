import { incrWithExpire, keys, TTL } from '../utils/cache.js';

/**
 * Redis sliding-window counter. Fails open if Redis is unavailable
 * so local development still works without a cache instance.
 */
export const redisRateLimit = ({
    bucket,
    windowSec = TTL.RATE_LIMIT,
    max,
    keyFn
}) => {
    return async (req, res, next) => {
        try {
            const identity = keyFn
                ? keyFn(req)
                : (req.user?._id?.toString() || req.ip || 'anon');

            const count = await incrWithExpire(
                keys.rateLimit(bucket, identity),
                windowSec
            );

            if (count === null) return next();

            res.setHeader('X-RateLimit-Limit', String(max));
            res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)));

            if (count > max) {
                return res.status(429).json({
                    message: 'Too many requests. Please try again later.'
                });
            }

            next();
        } catch (err) {
            next();
        }
    };
};

export const loginRateLimit = redisRateLimit({
    bucket: 'login',
    windowSec: 15 * 60,
    max: 12,
    keyFn: (req) => `${req.ip}:${(req.body?.email || '').toLowerCase()}`
});

export const aiRateLimit = redisRateLimit({
    bucket: 'ai',
    windowSec: 60 * 60,
    max: 20
});

export const reminderRateLimit = redisRateLimit({
    bucket: 'remind',
    windowSec: 60 * 60,
    max: 30
});
