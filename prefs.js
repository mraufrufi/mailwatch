import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    PRESETS, SECURITY, parseAccounts,
    lookupPassword, storePassword, clearPassword,
} from './common.js';

export default class MailWatchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const helperPath = GLib.build_filenamev([this.path, 'helper', 'imap_helper.py']);
        window.set_default_size(680, 760);

        const page = new Adw.PreferencesPage({
            title: 'Mail Watch',
            icon_name: 'mail-unread-symbolic',
        });
        window.add(page);

        // ---- Accounts -------------------------------------------------
        const accountsGroup = new Adw.PreferencesGroup({
            title: 'Accounts',
            description: 'IMAP accounts to watch. Passwords are stored in the GNOME Keyring.',
        });
        const addButton = new Gtk.Button({
            label: 'Add Account',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        accountsGroup.set_header_suffix(addButton);
        page.add(accountsGroup);

        let rows = [];
        const saveAccounts = list => {
            settings.set_string('accounts', JSON.stringify(list));
            settings.set_int('revision', settings.get_int('revision') + 1);
            renderAccounts();
        };

        const renderAccounts = () => {
            for (const r of rows)
                accountsGroup.remove(r);
            rows = [];
            const list = parseAccounts(settings);
            if (list.length === 0) {
                const empty = new Adw.ActionRow({
                    title: 'No accounts yet',
                    subtitle: 'Click “Add Account” to get started.',
                    sensitive: false,
                });
                accountsGroup.add(empty);
                rows.push(empty);
                return;
            }
            for (const acc of list) {
                const row = new Adw.ActionRow({
                    title: GLib.markup_escape_text(acc.name || acc.email, -1),
                    subtitle: GLib.markup_escape_text(`${acc.email} · ${acc.host}`, -1),
                });
                row.add_prefix(new Gtk.Image({icon_name: 'mail-unread-symbolic'}));

                const edit = new Gtk.Button({
                    icon_name: 'document-edit-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                    tooltip_text: 'Edit',
                });
                edit.connect('clicked', () => showDialog(acc));
                const del = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                    tooltip_text: 'Remove',
                });
                del.connect('clicked', () => confirmDelete(acc));
                row.add_suffix(edit);
                row.add_suffix(del);
                accountsGroup.add(row);
                rows.push(row);
            }
        };

        const confirmDelete = acc => {
            const dialog = new Adw.AlertDialog({
                heading: `Remove “${acc.name || acc.email}”?`,
                body: 'The account and its saved password will be removed.',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('remove', 'Remove');
            dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.choose(window, null, (d, res) => {
                if (d.choose_finish(res) !== 'remove')
                    return;
                clearPassword(acc.id).catch(() => {});
                saveAccounts(parseAccounts(settings).filter(a => a.id !== acc.id));
            });
        };

        // ---- Add / edit dialog ----------------------------------------
        const showDialog = existing => {
            const dialog = new Adw.Dialog({
                title: existing ? 'Edit Account' : 'Add Account',
                content_width: 500,
                content_height: 680,
            });
            const toolbar = new Adw.ToolbarView();
            const header = new Adw.HeaderBar({show_start_title_buttons: false, show_end_title_buttons: false});
            const cancel = new Gtk.Button({label: 'Cancel'});
            const save = new Gtk.Button({label: 'Save', css_classes: ['suggested-action']});
            header.pack_start(cancel);
            header.pack_end(save);
            toolbar.add_top_bar(header);

            const dpage = new Adw.PreferencesPage();
            const g1 = new Adw.PreferencesGroup({title: 'Account'});
            const g2 = new Adw.PreferencesGroup({
                title: 'Server',
                description: 'For Gmail, Yahoo and iCloud use an app password, not your normal password.',
            });
            dpage.add(g1);
            dpage.add(g2);

            const preset = new Adw.ComboRow({
                title: 'Provider',
                model: Gtk.StringList.new(PRESETS.map(p => p.name)),
            });
            const name = new Adw.EntryRow({title: 'Display name (e.g. Work)'});
            const email = new Adw.EntryRow({title: 'Email address', input_purpose: Gtk.InputPurpose.EMAIL});
            const username = new Adw.EntryRow({title: 'Username (blank = email address)'});
            const password = new Adw.PasswordEntryRow({
                title: existing ? 'Password (blank = keep current)' : 'Password / app password',
            });
            for (const w of [preset, name, email, username, password])
                g1.add(w);

            const host = new Adw.EntryRow({title: 'IMAP server'});
            const port = new Adw.EntryRow({title: 'Port', input_purpose: Gtk.InputPurpose.DIGITS});
            const security = new Adw.ComboRow({
                title: 'Encryption',
                model: Gtk.StringList.new(['SSL/TLS', 'STARTTLS']),
            });
            const webmail = new Adw.EntryRow({title: 'Webmail URL (opened when you click a message)'});
            for (const w of [host, port, security, webmail])
                g2.add(w);

            preset.connect('notify::selected', () => {
                const p = PRESETS[preset.selected];
                if (!p || p.name === 'Custom')
                    return;
                host.text = p.host;
                port.text = `${p.port}`;
                security.selected = p.security;
                webmail.text = p.webmail;
            });

            // Test + status
            const g3 = new Adw.PreferencesGroup();
            const status = new Gtk.Label({
                label: '',
                wrap: true,
                xalign: 0,
                hexpand: true,
                valign: Gtk.Align.CENTER,
            });
            const test = new Gtk.Button({label: 'Test Connection', valign: Gtk.Align.CENTER});
            const box = new Gtk.Box({spacing: 12, margin_top: 4});
            box.append(test);
            box.append(status);
            g3.add(box);
            dpage.add(g3);
            toolbar.set_content(dpage);
            dialog.set_child(toolbar);

            if (existing) {
                name.text = existing.name ?? '';
                email.text = existing.email ?? '';
                username.text = existing.username ?? '';
                host.text = existing.host ?? '';
                port.text = `${existing.port ?? 993}`;
                security.selected = Math.max(0, SECURITY.indexOf(existing.security));
                webmail.text = existing.webmail ?? '';
            } else {
                port.text = '993';
            }

            const setStatus = (text, cls) => {
                status.label = text;
                status.set_css_classes(cls ? [cls] : []);
            };

            const collect = () => ({
                id: existing?.id ?? GLib.uuid_string_random(),
                name: name.text.trim() || email.text.trim(),
                email: email.text.trim(),
                username: username.text.trim(),
                host: host.text.trim(),
                port: parseInt(port.text, 10),
                security: SECURITY[security.selected] ?? 'ssl',
                webmail: webmail.text.trim(),
            });

            const validate = acc => {
                if (!acc.email || !acc.host)
                    return 'Email address and IMAP server are required.';
                if (!(acc.port > 0 && acc.port < 65536))
                    return 'Port must be a number between 1 and 65535.';
                if (!existing && !password.text)
                    return 'Please enter a password.';
                return null;
            };

            test.connect('clicked', async () => {
                const acc = collect();
                const problem = validate(acc);
                if (problem) {
                    setStatus(problem, 'error');
                    return;
                }
                test.sensitive = false;
                setStatus('Connecting…', 'dim-label');
                try {
                    const pw = password.text || (existing ? await lookupPassword(existing.id) : '');
                    const proc = Gio.Subprocess.new(['python3', helperPath, '--test'],
                        Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
                    const input = JSON.stringify({
                        ...acc,
                        username: acc.username || acc.email,
                        password: pw ?? '',
                    });
                    const out = await new Promise((resolve, reject) => {
                        proc.communicate_utf8_async(input, null, (p, res) => {
                            try {
                                resolve(p.communicate_utf8_finish(res)[1]);
                            } catch (e) {
                                reject(e);
                            }
                        });
                    });
                    const result = JSON.parse(out);
                    if (result.ok)
                        setStatus(`Connected. ${result.unseen} unread message(s).`, 'success');
                    else
                        setStatus(`Failed: ${result.error}`, 'error');
                } catch (e) {
                    setStatus(`Failed: ${e.message}`, 'error');
                }
                test.sensitive = true;
            });

            cancel.connect('clicked', () => dialog.close());
            save.connect('clicked', async () => {
                const acc = collect();
                const problem = validate(acc);
                if (problem) {
                    setStatus(problem, 'error');
                    return;
                }
                try {
                    if (password.text)
                        await storePassword(acc.id, `Mail Watch: ${acc.email}`, password.text);
                } catch (e) {
                    setStatus(`Could not save password to keyring: ${e.message}`, 'error');
                    return;
                }
                const list = parseAccounts(settings);
                const i = list.findIndex(a => a.id === acc.id);
                if (i >= 0)
                    list[i] = acc;
                else
                    list.push(acc);
                saveAccounts(list);
                dialog.close();
            });

            dialog.present(window);
        };

        addButton.connect('clicked', () => showDialog(null));

        // ---- General --------------------------------------------------
        const general = new Adw.PreferencesGroup({title: 'Behavior'});
        page.add(general);
        const toggles = [
            ['show-notifications', 'Desktop notifications', 'Notify when a new email arrives'],
            ['notification-sound', 'Notification sound', 'Play a sound with each notification'],
            ['mark-read-on-click', 'Mark as read on open', 'Mark a message as read when opened from the list'],
        ];
        for (const [key, title, subtitle] of toggles) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            general.add(row);
        }

        renderAccounts();
    }
}
