import Notification from '../models/Notification.js';
import { io } from '../index.js';
import User from '../models/User.js';
import { cacheGet, invalidateNotifications, keys } from './cache.js';

export const sendNotification = async ({ recipient, sender, type, title, message, link }) => {
    try {
        let prefs = null;
        const cachedUser = await cacheGet(keys.user(recipient));
        if (cachedUser?.preferences) {
            prefs = cachedUser.preferences;
        } else {
            const user = await User.findById(recipient).select('preferences');
            prefs = user?.preferences;
        }

        if (prefs && prefs.emailNotifications === false) {
            console.log(`Notification skipped for ${recipient} due to preferences.`);
            return null;
        }

        const notification = new Notification({
            recipient,
            sender,
            type,
            title,
            message,
            link
        });

        await notification.save();

        await invalidateNotifications(recipient);

        // Emit to the recipient's private socket room
        if (io) {
            io.to(recipient.toString()).emit('notification', notification);
        }

        return notification;
    } catch (error) {
        console.error('Error sending real-time notification:', error);
    }
};
