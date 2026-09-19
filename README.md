# Mail Watch — GNOME Shell extension (GNOME 49+)

Multi-account unread-mail monitor for the top bar.

- Top-bar envelope icon with an unread-count badge
- Popup list of unread mail: avatar, sender, subject, time, account (when you have several)
- Realtime desktop notifications via IMAP IDLE (falls back to 60 s polling if a server lacks IDLE)
- Libadwaita preferences: add/edit/remove accounts, provider presets, "Test Connection"
- Passwords are stored in the GNOME Keyring (libsecret), never in settings files
- Click a message to open your webmail and mark it read; hover-free check button marks read without opening

## Install

    ./install.sh
    # log out / in (Wayland), then:
    gnome-extensions enable mailwatch@rauf
    gnome-extensions prefs mailwatch@rauf

Requirements: GNOME Shell 49, `python3`, and the libsecret typelib (`gir1.2-secret-1` on Debian/Ubuntu, `libsecret` on Fedora/Arch).

## Accounts

Gmail, Yahoo, iCloud, Fastmail and Zoho need an **app password** (enable 2-step verification, then create one in the provider's security settings). Microsoft Outlook.com / Microsoft 365 have disabled password IMAP for most accounts, so they are not supported (they need OAuth2).

## Layout

    extension.js        panel indicator, popup list, notifications, helper supervision
    prefs.js            libadwaita settings UI
    common.js           keyring access, provider presets
    helper/imap_helper.py   IMAP client (one thread per account, IDLE), JSON lines over stdio
    stylesheet.css

Debug: `journalctl -f -o cat /usr/bin/gnome-shell` and `gnome-extensions prefs mailwatch@rauf`.
Nested test session: `dbus-run-session gnome-shell --devkit --wayland`.
