import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { cacheGet, cacheSet, keys, TTL, toPlain } from '../utils/cache.js';

export const protect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            // Get token from header
            token = req.headers.authorization.split(' ')[1];

            // Verify token
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            const cachedUser = await cacheGet(keys.user(decoded.id));
            if (cachedUser) {
                req.user = cachedUser;
            } else {
                req.user = await User.findById(decoded.id).select('-password');
                if (req.user) {
                    await cacheSet(keys.user(decoded.id), toPlain(req.user), TTL.USER);
                }
            }

            if (!req.user) {
                return res.status(401).json({ message: 'Not authorized, user not found' });
            }

            next();
        } catch (error) {
            console.error(error);
            res.status(401).json({ message: 'Not authorized, token failed' });
        }
    }

    if (!token) {
        res.status(401).json({ message: 'Not authorized, no token' });
    }
};

// Middleware to restrict access to specific roles
export const authorize = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                message: `User role ${req.user.role} is not authorized to access this route`
            });
        }
        next();
    };
};
