export const chatStrings = {
	'chat.attachment.empty-drop': {
		en: 'Nothing to attach — that drop contained no file.',
		tr: 'Eklenecek bir şey yok — bu bırakma işlemi dosya içermiyordu.',
	},
	'chat.attachment.no-active-note': { en: 'No active note to attach.', tr: 'Eklenecek etkin not yok.' },
	'chat.attachment.no-filesystem-path': {
		en: 'Could not read a filesystem path for the chosen file.',
		tr: 'Seçilen dosyanın dosya sistemi yolu okunamadı.',
	},
	'chat.conversation.empty': {
		en: 'This conversation has no messages to display.',
		tr: 'Bu konuşmada gösterilecek mesaj yok.',
	},
	'chat.conversation.load-failed': { en: 'Could not load conversation.', tr: 'Konuşma yüklenemedi.' },
	'chat.conversation.load-older': { en: 'Load older messages', tr: 'Eski mesajları yükle' },
	'chat.conversation.load-older-failed': {
		en: 'Could not load older messages.',
		tr: 'Eski mesajlar yüklenemedi.',
	},
	'chat.attachment.outside-vault': {
		en: 'Could not attach {files} — it does not resolve inside the vault.',
		tr: '{files} eklenemedi — kasa içinde çözümlenemiyor.',
	},
	'chat.attachment.folder': {
		en: 'Cannot attach the folder {folders} — attach the files inside it.',
		tr: '{folders} klasörü eklenemez — içindeki dosyaları ekleyin.',
	},
	'chat.attachment.path-missing': {
		en: 'Could not attach {files} — that path no longer resolves.',
		tr: '{files} eklenemedi — bu yol artık çözümlenemiyor.',
	},
	'chat.attachment.unsupported-images': {
		en: 'Cannot attach {images} — only PNG, JPEG, GIF and WebP images can be sent.',
		tr: '{images} eklenemez — yalnızca PNG, JPEG, GIF ve WebP görselleri gönderilebilir.',
	},
	'chat.attachment.image-data-unavailable': {
		en: 'Could not read {files} — the image data was unavailable.',
		tr: '{files} okunamadı — görsel verisi kullanılamıyor.',
	},
	'chat.header.history': { en: 'Conversation history', tr: 'Konuşma geçmişi' },
	'chat.header.new-conversation': { en: 'New conversation', tr: 'Yeni konuşma' },
	'chat.composer.placeholder.enter': {
		en: 'Message GuKi… (Enter to send, Shift+Enter for a new line)',
		tr: "GuKi'ye mesaj yazın… (Göndermek için Enter, yeni satır için Shift+Enter)",
	},
	'chat.composer.placeholder.mod-enter': {
		en: 'Message GuKi… (Cmd/Ctrl+Enter to send, Enter for a new line)',
		tr: "GuKi'ye mesaj yazın… (Göndermek için Cmd/Ctrl+Enter, yeni satır için Enter)",
	},
	'chat.composer.attach-files': { en: 'Attach files from disk', tr: 'Diskten dosya ekle' },
	'chat.composer.attach-active-note': { en: 'Attach the active note', tr: 'Etkin notu ekle' },
	'chat.composer.send': { en: 'Send the message', tr: 'Mesajı gönder' },
	'chat.composer.remove': { en: 'Remove {name}', tr: '{name} öğesini kaldır' },
	'chat.composer.stop': { en: 'Stop the current reply', tr: 'Mevcut yanıtı durdur' },
	'chat.composer.compacting': { en: 'Compacting conversation…', tr: 'Konuşma sıkıştırılıyor…' },
	'chat.composer.context': { en: 'Context {percent}%', tr: 'Bağlam {percent}%' },
	'chat.composer.quota.five-hour': { en: '5h {bar} {percent}%', tr: '5h {bar} {percent}%' },
	'chat.composer.quota.seven-day': { en: '7d {bar} {percent}%', tr: '7d {bar} {percent}%' },
	'chat.history.untitled-session': { en: 'Untitled session', tr: 'Adsız oturum' },
	'chat.history.empty': {
		en: 'No past conversations found in this vault.',
		tr: 'Bu kasada önceki konuşma bulunamadı.',
	},
	'chat.history.rename-session': { en: 'Rename session', tr: 'Oturumu yeniden adlandır' },
	'chat.history.derived': { en: 'Derived: {title}', tr: 'Türetilmiş: {title}' },
	'chat.history.rename-conversation': { en: 'Rename conversation', tr: 'Konuşmayı yeniden adlandır' },
} as const;
