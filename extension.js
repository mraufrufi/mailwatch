import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {lookupPassword, parseAccounts} from './common.js';

const AVATAR_COLORS = [
    '#3584e4', '#33a06f', '#e5a50a', '#e66100',
    '#c64600', '#9141ac', '#d6336c', '#2ec27e',
];

function colorFor(text) {
    let h = 0;
    for (const ch of text.toLowerCase())
        h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function formatTime(ts) {
    const now = GLib.DateTime.new_now_local();
    const then = GLib.DateTime.new_from_unix_local(ts);
    const diff = now.difference(then) / 1e6; // seconds
    if (diff < 60)
        return 'now';
    if (diff < 3600)
        return `${Math.floor(diff / 60)}m ago`;
    if (then.format('%Y%m%d') === now.format('%Y%m%d'))
        return then.format('%H:%M');
    if (diff < 2 * 86400 && then.format('%Y%m%d') === now.add_days(-1).format('%Y%m%d'))
        return 'Yesterday';
    if (then.get_year() === now.get_year())
        return then.format('%b %-e');
    return then.format('%b %-e, %Y');
}

function ellipsize(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

const MailIndicator = GObject.registerClass(
class MailIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Mail Watch', false);
        this._ext = ext;
        this._messages = [];
        this._total = 0;
        this._errors = [];
        this._hasAccounts = false;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box mw-panel-box'});
        this._icon = new St.Icon({
            icon_name: 'mail-read-symbolic',
            style_class: 'system-status-icon',
        });
        this._badge = new St.Label({
            style_class: 'mw-badge',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._icon);
        box.add_child(this._badge);
        this.add_child(box);

        this.menu.box.add_style_class_name('mw-menu');

        // Header -------------------------------------------------------
        const header = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'mw-header',
        });
        this._title = new St.Label({
            text: 'Unread mail',
            style_class: 'mw-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._title);
        header.add_child(this._iconButton('object-select-symbolic', 'Mark all as read',
            () => this._ext.markAllRead()));
        header.add_child(this._iconButton('view-refresh-symbolic', 'Refresh',
            () => this._ext.refresh()));
        header.add_child(this._iconButton('emblem-system-symbolic', 'Settings', () => {
            this.menu.close();
            this._ext.openPreferences();
        }));
        this.menu.addMenuItem(header);

        // Error banner -------------------------------------------------
        this._errorLabel = new St.Label({style_class: 'mw-error', visible: false});
        this._errorLabel.clutter_text.line_wrap = true;
        const errSection = new PopupMenu.PopupMenuSection();
        errSection.box.add_child(this._errorLabel);
        this.menu.addMenuItem(errSection);

        // List ---------------------------------------------------------
        this._list = new St.BoxLayout({vertical: true, style_class: 'mw-list'});
        this._scroll = new St.ScrollView({
            style_class: 'mw-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._scroll.set_child(this._list);
        const listSection = new PopupMenu.PopupMenuSection();
        listSection.box.add_child(this._scroll);
        this.menu.addMenuItem(listSection);

        this._rebuild();
    }

    _iconButton(iconName, tooltip, cb) {
        const btn = new St.Button({
            style_class: 'mw-icon-button',
            can_focus: true,
            track_hover: true,
            accessible_name: tooltip,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        btn.connect('clicked', cb);
        return btn;
    }

    update(messages, total, errors, hasAccounts) {
        this._messages = messages;
        this._total = total;
        this._errors = errors;
        this._hasAccounts = hasAccounts;
        this._rebuild();
    }

    _rebuild() {
        const total = this._total;
        this._icon.icon_name = total > 0 ? 'mail-unread-symbolic' : 'mail-read-symbolic';
        this._badge.visible = total > 0;
        this._badge.text = total > 99 ? '99+' : `${total}`;
        this._title.text = total > 0 ? `Unread mail (${total})` : 'Unread mail';

        this._errorLabel.visible = this._errors.length > 0;
        this._errorLabel.text = this._errors.join('\n');

        this._list.destroy_all_children();

        if (!this._hasAccounts) {
            this._list.add_child(this._emptyState('mail-send-symbolic',
                'No accounts yet', 'Open settings to add an email account.'));
            return;
        }
        if (this._messages.length === 0) {
            this._list.add_child(this._emptyState('emblem-ok-symbolic',
                'All caught up', 'No unread messages.'));
            return;
        }

        const multi = this._ext.accountCount() > 1;
        for (const msg of this._messages)
            this._list.add_child(this._makeRow(msg, multi));

        if (this._total > this._messages.length) {
            this._list.add_child(new St.Label({
                text: `and ${this._total - this._messages.length} more…`,
                style_class: 'mw-more',
            }));
        }
    }

    _emptyState(iconName, title, subtitle) {
        const box = new St.BoxLayout({vertical: true, style_class: 'mw-empty', x_expand: true});
        box.add_child(new St.Icon({
            icon_name: iconName,
            icon_size: 40,
            style_class: 'mw-empty-icon',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            text: title,
            style_class: 'mw-empty-title',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            text: subtitle,
            style_class: 'mw-empty-sub',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        return box;
    }

    _makeRow(msg, showAccount) {
        const row = new St.Button({
            style_class: 'mw-row',
            can_focus: true,
            track_hover: true,
            x_expand: true,
        });
        const h = new St.BoxLayout({x_expand: true});

        const initial = (msg.sender || '?').trim().charAt(0).toUpperCase() || '?';
        const avatar = new St.Bin({
            style_class: 'mw-avatar',
            style: `background-color: ${colorFor(msg.email || msg.sender)};`,
            y_align: Clutter.ActorAlign.START,
            child: new St.Label({
                text: initial,
                style_class: 'mw-avatar-text',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
            }),
        });
        h.add_child(avatar);

        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'mw-col'});
        const top = new St.BoxLayout({x_expand: true});
        top.add_child(ellipsize(new St.Label({
            text: msg.sender,
            style_class: 'mw-sender',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        })));
        top.add_child(new St.Label({
            text: formatTime(msg.ts),
            style_class: 'mw-time',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        col.add_child(top);
        col.add_child(ellipsize(new St.Label({text: msg.subject, style_class: 'mw-subject'})));

        let meta = msg.email || '';
        if (showAccount)
            meta = meta ? `${meta}  ·  ${msg.accountName}` : msg.accountName;
        col.add_child(ellipsize(new St.Label({text: meta, style_class: 'mw-meta'})));
        h.add_child(col);

        const readBtn = this._iconButton('object-select-symbolic', 'Mark as read',
            () => this._ext.markRead(msg));
        readBtn.add_style_class_name('mw-row-action');
        readBtn.y_align = Clutter.ActorAlign.CENTER;
        h.add_child(readBtn);

        row.set_child(h);
        row.connect('clicked', () => {
            this.menu.close();
            this._ext.openMessage(msg);
        });
        return row;
    }
});

export default class MailWatchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._store = new Map();    // accountId -> {messages, total}
        this._status = new Map();   // accountId -> {state, error}
        this._gen = 0;
        this._source = null;

        this._indicator = new MailIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._settingsIds = ['accounts', 'revision'].map(k =>
            this._settings.connect(`changed::${k}`, () => this._queueRestart()));

        this._clock = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });

        this._startHelper();
    }

    disable() {
        if (this._clock) {
            GLib.source_remove(this._clock);
            this._clock = null;
        }
        if (this._restartId) {
            GLib.source_remove(this._restartId);
            this._restartId = null;
        }
        this._stopHelper();
        this._gen++;
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = null;
        this._source?.destroy();
        this._source = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
        this._store = null;
        this._status = null;
    }

    // ---- accounts --------------------------------------------------------
    _accounts() {
        return parseAccounts(this._settings);
    }

    accountCount() {
        return this._accounts().length;
    }

    _account(id) {
        return this._accounts().find(a => a.id === id);
    }

    // ---- helper process --------------------------------------------------
    _queueRestart() {
        if (this._restartId)
            GLib.source_remove(this._restartId);
        this._restartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._restartId = null;
            this._startHelper();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _startHelper() {
        this._stopHelper();
        const gen = ++this._gen;
        this._store.clear();
        this._status.clear();

        const accounts = this._accounts();
        const payload = [];
        for (const acc of accounts) {
            let password = null;
            try {
                password = await lookupPassword(acc.id);
            } catch (e) {
                logError(e, 'Mail Watch: keyring lookup failed');
            }
            if (gen !== this._gen)
                return;
            if (!password) {
                this._status.set(acc.id, {state: 'error', error: 'No saved password'});
                continue;
            }
            payload.push({
                id: acc.id,
                host: acc.host,
                port: acc.port,
                security: acc.security,
                username: acc.username || acc.email,
                password,
            });
        }
        this._render();
        if (payload.length === 0)
            return;

        try {
            const helper = GLib.build_filenamev([this.path, 'helper', 'imap_helper.py']);
            this._proc = Gio.Subprocess.new(['python3', helper],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
        } catch (e) {
            logError(e, 'Mail Watch: cannot start helper');
            for (const acc of accounts)
                this._status.set(acc.id, {state: 'error', error: 'Cannot start python3 helper'});
            this._render();
            return;
        }
        this._stdin = this._proc.get_stdin_pipe();
        this._cancellable = new Gio.Cancellable();
        const reader = new Gio.DataInputStream({
            base_stream: this._proc.get_stdout_pipe(),
            close_base_stream: true,
        });
        this._readLoop(reader, gen);
        this._send({cmd: 'config', accounts: payload});
    }

    _stopHelper() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._proc) {
            try {
                this._proc.force_exit();
            } catch (e) { /* already gone */ }
            this._proc = null;
        }
        this._stdin = null;
    }

    _send(obj) {
        if (!this._stdin)
            return;
        try {
            const bytes = new TextEncoder().encode(`${JSON.stringify(obj)}\n`);
            this._stdin.write_all(bytes, null);
            this._stdin.flush(null);
        } catch (e) {
            logError(e, 'Mail Watch: write to helper failed');
        }
    }

    _readLoop(reader, gen) {
        reader.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (r, res) => {
            let line;
            try {
                [line] = r.read_line_finish_utf8(res);
            } catch (e) {
                return; // cancelled
            }
            if (gen !== this._gen)
                return;
            if (line === null) {
                for (const acc of this._accounts())
                    this._status.set(acc.id, {state: 'error', error: 'Mail helper stopped'});
                this._render();
                return;
            }
            try {
                this._handle(JSON.parse(line));
            } catch (e) {
                logError(e, 'Mail Watch: bad helper message');
            }
            this._readLoop(r, gen);
        });
    }

    _handle(ev) {
        switch (ev.type) {
        case 'status':
            this._status.set(ev.account, {state: ev.state, error: ev.error ?? ''});
            break;
        case 'list':
            this._store.set(ev.account, {messages: ev.messages, total: ev.total});
            break;
        case 'new':
            this._notify(ev.account, ev.messages);
            return;
        }
        this._render();
    }

    // ---- UI --------------------------------------------------------------
    _render() {
        if (!this._indicator)
            return;
        const accounts = this._accounts();
        const names = new Map(accounts.map(a => [a.id, a.name || a.email]));

        let all = [];
        let total = 0;
        for (const [id, entry] of this._store) {
            if (!names.has(id))
                continue;
            total += entry.total;
            for (const m of entry.messages)
                all.push({...m, accountName: names.get(id)});
        }
        all.sort((a, b) => b.ts - a.ts);
        all = all.slice(0, 100);

        const errors = [];
        for (const acc of accounts) {
            const st = this._status.get(acc.id);
            if (st?.state === 'error')
                errors.push(`${names.get(acc.id)}: ${st.error}`);
        }
        this._indicator.update(all, total, errors, accounts.length > 0);
    }

    // ---- actions ---------------------------------------------------------
    refresh() {
        this._send({cmd: 'refresh'});
    }

    markAllRead() {
        for (const entry of this._store.values()) {
            entry.messages = [];
            entry.total = 0;
        }
        this._render();
        this._send({cmd: 'mark_all_read', account: null});
    }

    markRead(msg) {
        const entry = this._store.get(msg.account);
        if (entry) {
            entry.messages = entry.messages.filter(m => m.uid !== msg.uid);
            entry.total = Math.max(0, entry.total - 1);
        }
        this._render();
        this._send({cmd: 'mark_read', account: msg.account, uids: [msg.uid]});
    }

    openMessage(msg) {
        const acc = this._account(msg.account);
        this._launch(acc?.webmail || 'mailto:');
        if (this._settings.get_boolean('mark-read-on-click'))
            this.markRead(msg);
    }

    _launch(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            logError(e, `Mail Watch: cannot open ${uri}`);
        }
    }

    // ---- notifications ---------------------------------------------------
    _ensureSource() {
        if (this._source)
            return this._source;
        this._source = new MessageTray.Source({
            title: 'Mail Watch',
            iconName: 'mail-unread-symbolic',
        });
        this._source.connect('destroy', () => {
            this._source = null;
        });
        Main.messageTray.add(this._source);
        return this._source;
    }

    _notify(accountId, messages) {
        if (!this._settings.get_boolean('show-notifications') || messages.length === 0)
            return;
        const acc = this._account(accountId);
        const accName = acc?.name || acc?.email || 'Mail';
        const source = this._ensureSource();
        const icon = new Gio.ThemedIcon({name: 'mail-unread-symbolic'});

        const show = (title, body, onActivate, actions = []) => {
            const n = new MessageTray.Notification({source, title, body, gicon: icon});
            for (const [label, cb] of actions)
                n.addAction(label, cb);
            n.connect('activated', onActivate);
            source.addNotification(n);
        };

        if (messages.length <= 3) {
            for (const m of messages) {
                const fromLine = m.email ? `${m.sender} <${m.email}>` : m.sender;
                show(m.subject, `${fromLine}\n${accName}`,
                    () => this.openMessage({...m, account: accountId}),
                    [['Mark as read', () => this.markRead({...m, account: accountId})]]);
            }
        } else {
            const senders = [...new Set(messages.map(m => m.sender))].slice(0, 3).join(', ');
            show(`${messages.length} new messages`, `${senders}\n${accName}`,
                () => this._launch(acc?.webmail || 'mailto:'));
        }

        if (this._settings.get_boolean('notification-sound')) {
            try {
                global.display.get_sound_player().play_from_theme(
                    'message-new-instant', 'New mail', null);
            } catch (e) { /* sound theme missing */ }
        }
    }
}
