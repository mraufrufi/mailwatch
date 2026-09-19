import Gio from 'gi://Gio';
import Secret from 'gi://Secret';

// Passwords live in the GNOME Keyring (libsecret), never in GSettings.
export const SECRET_SCHEMA = Secret.Schema.new(
    'org.gnome.shell.extensions.mailwatch',
    Secret.SchemaFlags.NONE,
    {account_id: Secret.SchemaAttributeType.STRING});

Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_store', 'password_store_finish');
Gio._promisify(Secret, 'password_clear', 'password_clear_finish');

const attrs = id => ({account_id: id});

export function lookupPassword(id) {
    return Secret.password_lookup(SECRET_SCHEMA, attrs(id), null);
}

export function storePassword(id, label, password) {
    return Secret.password_store(SECRET_SCHEMA, attrs(id),
        Secret.COLLECTION_DEFAULT, label, password, null);
}

export function clearPassword(id) {
    return Secret.password_clear(SECRET_SCHEMA, attrs(id), null);
}

export const PRESETS = [
    {name: 'Custom', host: '', port: 993, security: 0, webmail: ''},
    {name: 'Gmail', host: 'imap.gmail.com', port: 993, security: 0, webmail: 'https://mail.google.com/mail/'},
    {name: 'Yahoo', host: 'imap.mail.yahoo.com', port: 993, security: 0, webmail: 'https://mail.yahoo.com/'},
    {name: 'iCloud', host: 'imap.mail.me.com', port: 993, security: 0, webmail: 'https://www.icloud.com/mail'},
    {name: 'Fastmail', host: 'imap.fastmail.com', port: 993, security: 0, webmail: 'https://app.fastmail.com/mail/'},
    {name: 'Zoho', host: 'imap.zoho.com', port: 993, security: 0, webmail: 'https://mail.zoho.com/'},
];

export const SECURITY = ['ssl', 'starttls'];

export function parseAccounts(settings) {
    try {
        const list = JSON.parse(settings.get_string('accounts'));
        return Array.isArray(list) ? list : [];
    } catch (e) {
        return [];
    }
}
