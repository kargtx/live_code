# Live Python Room

Локальное веб-приложение для лайв-кодинга в комнате:

- слева общий редактор Python;
- справа общая доска для рисования, стирания и вставки изображения;
- снизу общий вывод выполнения кода;
- ссылка с параметром `?room=...` открывает одну и ту же комнату для двух участников.

## Запуск

```powershell
python server.py
```

Откройте `http://localhost:3000`.

Python запускается локально через Python 3, поэтому `import` работает для стандартной библиотеки и установленных в вашей системе пакетов.

## Ubuntu + PM2

```bash
cd /path/to/live_code
pm2 start server.py --name live-python-room --interpreter python3
pm2 save
```

Снаружи сервер будет доступен по `http://SERVER_IP:3000`, если порт 3000 открыт в firewall/security group.
