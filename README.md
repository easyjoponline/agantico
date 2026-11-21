# Agantico — MCP Media Generator + خدمة دمج الفيديو

مشروعان في مستودع واحد:

1. **MCP Media Generator** (جذر المستودع) — خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي مع نظام مفاتيح متسلسلة بتبديل تلقائي، ولوحة إدارة عربية، على **Next.js + Turso**.
2. **خدمة دمج الفيديو** (مجلد `merger/`) — موقع دمج فيديو كامل بواجهة برمجية عامة، على **Node.js خالص (Vercel Serverless) + Turso + ffmpeg**.

| القدرة | التفاصيل |
|---|---|
| توليد صور | `gpt-image-2-6/flare-text-to-image` |
| توليد فيديو (صوت متزامن أصلي) | `grok-imagine-video-1-5-preview` |
| دمج مقاطع | حتى 10 مقاطع → MP4 واحد (H.264 + AAC، حتى 1080p، CRF 18) |
| المزودون | kie.ai (أساسي) + CometAPI (ثانوي، اختياري) |

**قواعد جوهرية مطبّقة:**
- لا يُنزَّل أي ملف وسائط على السيرفر — تُخزَّن **روابط النتائج فقط** في قاعدة البيانات.
- المفاتيح تُجرَّب **بتسلسل صارم حسب ترتيب الإضافة** (أول مفتاح ثم التالي...) مع **تبديل فوري تلقائي** عند أي خطأ أو نفاد رصيد دون توقف المهمة — نفس المهمة تُستأنف بنفس `task_id`.
- نموذج الذكاء الاصطناعي **لا يرى أبدًا** أخطاء المفاتيح أو الرصيد.
- مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل استدعاء `get_task` (بتهدئة ~45 ثانية).
- المفاتيح مُخفية دائمًا في كل الاستجابات (`maskKey`)، ولا أسرار في Git (`.env*` مستثنى منذ أول commit).

---

## 1) بنية المستودع

```
├── src/                     # تطبيق Next.js (MCP Media Generator)
│   ├── app/mcp/route.ts     # خادم MCP على /mcp (Streamable HTTP رسمي من SDK)
│   ├── app/api/             # health / keys / tasks
│   ├── app/page.tsx         # لوحة الإدارة العربية RTL
│   └── lib/                 # turso / keys / models / providers / orchestrator / merger / mcp
└── merger/                  # خدمة دمج الفيديو (مشروع Vercel منفصل)
    ├── api/                 # دوال Serverless خالصة (CommonJS)
    ├── lib/                 # قاعدة البيانات / محرك ffmpeg / أدوات
    ├── public/index.html    # واجهة الموقع (ملف واحد، عربية RTL)
    └── scripts/             # dev server يحاكي Vercel + اختبارات وحدات و HTTP
```

---

## 2) متغيرات البيئة

### المشروع الأول (جذر المستودع على Vercel)

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | `libsql://<db-name>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | ✅ | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | ✅ للدمج | عنوان مشروع الدمج بعد نشره، مثل `https://agantico-merger.vercel.app` |
| `MCP_ACCESS_TOKEN` | اختياري | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | اختياري | تجاوز اسم الموديل لدى kie.ai |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | اختياري | تجاوز اسم الموديل لدى CometAPI |

### مشروع الدمج (`merger/` على Vercel)

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | نفس قاعدة Turso (جداول منفصلة: `jobs`, `sources`, `source_chunks`, `output_chunks`) |
| `TURSO_AUTH_TOKEN` | ✅ | نفس التوكن |
| `MAX_SOURCES` | اختياري | 10 افتراضيًا |
| `SOURCE_MAX_MB` | اختياري | 200 افتراضيًا |
| `OUTPUT_MAX_MB` | اختياري | 150 افتراضيًا |
| `MAX_TOTAL_DURATION_SEC` | اختياري | 600 افتراضيًا |
| `FFMPEG_PRESET` | اختياري | `medium` افتراضيًا |

> ⚠️ ملفات `.env*` غير مرفوعة إلى Git إطلاقًا — القيم تُوضع في Vercel → Settings → Environment Variables، ومحليًا في `.env.local` / `merger/.env`.

---

## 3) النشر على Vercel (خطوة بخطوة)

المستودع يُنشئ **مشروعين** على Vercel من نفس الريبو:

### أ) مشروع خدمة الدمج أولًا (لأن الأول يحتاج عنوانه)
1. Vercel → **Add New → Project** → اختر مستودع `easyjoponline/agantico`.
2. في **Root Directory** اختر `merger` (Framework Preset: Other — سيكتشف دوال `api/` تلقائيًا).
3. Environment Variables: أضف `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (يمكن إبقاء الباقي على الافتراضي).
4. Deploy → انسخ الدومين مثل `https://agantico-merger.vercel.app`.
5. جرّب: افتح `https://<domin>/api/config` — يجب أن يعيد JSON الحدود، والصفحة الرئيسية تعرض واجهة الدمج.

### ب) مشروع MCP Media Generator
1. Vercel → **Add New → Project** → نفس المستودع مرة ثانية.
2. اترك **Root Directory** فارغًا (الجذر) — يكتشف Next.js تلقائيًا.
3. Environment Variables: `TURSO_DATABASE_URL`، `TURSO_AUTH_TOKEN`، و `MERGER_API_BASE` = دومين مشروع الدمج من الخطوة (أ).
4. Deploy.
5. افتح اللوحة → يجب أن ترى شارة «Turso متصل» خضراء وشارة «الدمج جاهز».

### ج) إضافة مفتاح التوليد
من لوحة المشروع الأول → **مدير المفاتيح** → اختر `kie.ai` → ألصق المفتاح → إضافة.
(يمكنك تكرار العملية لأي عدد من المفاتيح — التجربة تسلسلية بالترتيب الذي أضفتها به.)

### ملاحظات حدود الخطة المجانية (Hobby)
- `maxDuration: 300` مطلوب في `merger/vercel.json` — يعمل مع **Fluid Compute** المفعّل افتراضيًا في المشاريع الجديدة. لو رفض Vercel القيمة فخفضها إلى `60` (الدمج يبقى يعمل للمقاطع القصيرة).
- حد حجم الطلب ≈ 4.5MB — لذلك الرفع من الواجهة يتم على أجزاء POST ثنائية 4MB مع إعادة محاولة ×3.
- مجلد `/tmp` مؤقت فقط — كل التخزين الدائم في Turso.
- حدود Turso المجانية (حجم قاعدة/قراءات) تكفي الاستخدام الخفيف — راجع صفحة الحدود لدى Turso.

### التشغيل المحلي

```bash
# المشروع الأول
cp .env.example .env.local   # ضع القيم الحقيقية
npm install
npm run build && npm start   # http://localhost:3000

# خدمة الدمج
cd merger
cp .env.example .env         # ضع القيم الحقيقية
npm install
npm run dev                  # http://localhost:3001 (خادم يحاكي Vercel)
npm run test:unit            # اختبار وحدات المحرك والتخزين (10 فحوص)
npm run test:http            # اختبار HTTP كامل ضد خادم التطوير (21 فحصًا)
```

---

## 4) ربط عملاء MCP

العنوان: `<origin>/mcp` (Streamable HTTP، وضع عديم الحالة، بث SSE لإشعارات التقدم).

```json
// ChatGPT / GPT Agents — Settings → Connectors → Create → Custom MCP server
{ "mcpServers": { "media-generator": { "url": "https://<app>.vercel.app/mcp" } } }

// Claude Desktop — claude_desktop_config.json
{ "mcpServers": { "media-generator": { "type": "http", "url": "https://<app>.vercel.app/mcp" } } }

// Cursor / Windsurf / Cline — mcp.json
{ "mcpServers": { "media-generator": { "url": "https://<app>.vercel.app/mcp" } } }
```

إن ضُبط `MCP_ACCESS_TOKEN` أضف `"headers": { "Authorization": "Bearer <token>" }` لكل إدخال.

### الأدوات الخمس

| الأداة | الوصف |
|---|---|
| `generate_image` | توليد صورة بـ `gpt-image-2-6/flare-text-to-image` — تعيد رابطًا جاهزًا إن اكتملت خلال نافذة الانتظار، وإلا `task_id`. |
| `generate_video` | توليد فيديو بـ `grok-imagine-video-1-5-preview` (صوت متزامن أصلي، image-to-video اختياري) — يتبعه بـ `get_task`. |
| `merge_videos` | دمج حتى 10 مقاطع بالترتيب — عبر `urls` مباشرة أو `task_ids` لمهام مكتملة. ملف الدمج يُحذف من الخدمة بعد ~24 ساعة. |
| `get_task` | تتبع أي مهمة (توليد أو دمج) — استعلمه كل ~10 ثوانٍ حتى `completed` ثم اعرض الرابط وتوقف. |
| `list_media` | أحدث الوسائط المخزنة بروابطها من قاعدة البيانات. |

### مثال اختبار سريع بـ curl

```bash
# قائمة الأدوات
curl -s -X POST https://<app>.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# توليد صورة
curl -s -N -X POST https://<app>.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"a red cube","wait_seconds":90}}}'

# صحة النظام
curl -s https://<app>.vercel.app/api/health
```

---

## 5) واجهة برمجة خدمة الدمج (عامة، CORS مفتوح، الأخطاء `{"error":"..."}`)

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة: `{"videos":["رابط1","رابط2"]}` أو `{"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}` → `201` مع `jobId/statusUrl/processUrl/expiresAt` و `uploads[]` للملفات |
| `POST` | `/api/upload?job=<id>&seq=<n>` | رفع أجزاء ثنائية ≤4MB (Content-Type: application/octet-stream) |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا → `{"status":"done","videoUrl","downloadUrl","size","duration","resolution","expiresAt"}` (قيد المعالجة → `202`) |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم 0–100 + الرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث الناتج بدعم Range (206)، و`?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل (المهمة والأجزاء والناتج) |
| `GET` | `/api/config` | الحدود العامة + version (فحص الجهوزية) |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي `0 3 * * *` في `vercel.json`) |

```bash
curl -X POST https://<merger>.vercel.app/api/jobs -H "Content-Type: application/json" \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'
curl -X POST https://<merger>.vercel.app/api/jobs/<JOB_ID>/process
curl -o out.mp4 -L "https://<merger>.vercel.app/api/jobs/<JOB_ID>/video?download=1"
```

### محرك الدمج
- ffprobe لكل مصدر (الدقة/المدة/الصوت) → توحيد الكل إلى أكبر دقة بين المدخلات (بحد أقصى 1920×1080، أبعاد زوجية) عبر `scale+pad`، `fps=30`، `setsar=1`، `format=yuv420p`، ثم `concat=n=:v=1:a=1`.
- مصدر بلا صوت يُكمل بمسار صامت `anullsrc` بنفس مدته — لا يفشل الدمج.
- الترميز: `libx264 CRF 18 + AAC 192k/44100Hz + +faststart` — MP4 يعمل فورًا على الويب.
- تقدم حقيقي: 0–40 سحب المصادر، 40–90 ترميز (من `-progress pipe:1`)، 100 اكتمال.
- التخزين: كل Blob يُقسَّم لصفوف 2MB في Turso ويُقرأ بصفحات — بث الفيديو يدعم Range للتكديم/الترجيع.
- الملفات (المصادر المرفوعة والناتج) تُحذف تلقائيًا بعد 24 ساعة (`expires_at` + تنظيف كسول + cron يومي)، وبعد نجاح الدمج تُحذف أجزاء المصادر فورًا.

---

## 6) نظام المفاتيح المتسلسلة (كيف يعمل)

1. `getKeyPool` تجلب المفاتيح غير المعطّلة للمزودين المطلوبين **بالترتيب الصارم**: `ORDER BY created_at ASC, id ASC` — أول مفتاح أُضيف يُجرَّب أولًا (ليس round-robin وليس الأقل استخدامًا).
2. تصنيف كل خطأ (`classifyProviderError`): `exhausted` (402 أو رسائل النفاد — تُفحص قبل 400) → علامة `exhausted` والانتقال للتالي؛ `disabled` (401/403 أو رسائل الرفض) → تعطيل تلقائي والانتقال؛ `provider` (موديل غير مدعوم) → الانتقال؛ `params` (400/422 معطيات) → **توقف فورًا**؛ `temporary` (429/5xx/شبكة) → الانتقال الآن.
3. عند فشل منتصف المهمة برسالة مفتاح/رصيد: إعادة إنشاء **نفس المهمة بنفس `task_id`** على المفتاح التالي تلقائيًا — العميل يرى «قيد المعالجة» فقط.
4. فشل على كل المفاتيح → تبقى `processing` برسالة داخلية «بانتظار توفر مفتاح صالح…» وتُعاد المحاولة مع كل `get_task` بعد تهدئة ~45 ثانية — لو شُحن رصيد أي مفتاح تكتمل المهمة تلقائيًا.
5. المفتاح المستنزف يبقى في القاعدة بحالة `exhausted` ولا يعيق المفاتيح التالية؛ الاستثناء الوحيد للإقصاء هو التعطيل اليدوي من الواجهة.

كل محاولة (نجاح/فشل + الفئة) تُسجَّل في `attempts_json` وعدّادات المفتاح (`usage/success/fail`, `last_error`) تتحدث دائمًا وتظهر في لوحة الإدارة.

---

## 7) الاختبارات التي اجتازها المشروع قبل التسليم

- `tsc --noEmit` نظيف و `next build` ناجح.
- `GET /api/health` يعيد `ok:true` و `database:"turso-connected"` و `merger.healthy:true`.
- `tools/list` يعرض الأدوات الخمس بمخططاتها (الدمج بحد 10 وبلا resolution/fps).
- **e2e صورة حقيقية** بمفتاح صحيح → رابط صورة يعمل (HTTP 200).
- **اختبار التبديل التسلسلي الحقيقي**: مفتاح خاطئ أولًا ثم المفتاح الصحيح → نفس المهمة اكتملت على الثاني، الخاطئ صار `disabled`، ولم يصل العميل أي ذكر للمفاتيح أو الرصيد.
- **e2e فيديو حقيقي** → `task_id` يتابعه `get_task` كل 10 ثوانٍ حتى رابط MP4 صالح (HTTP 200).
- **اختبار وحدات الدمج**: 10/10 — دقة الناتج = أكبر دقة مدخل، المدة ≈ مجموع المدد، الصوت موجود للمصدر الصامت، تخزين/استرجاع Turso بتطابق sha256، مسار رفع الأجزاء، الحذف الشامل.
- **اختبار HTTP للدمج**: 21/21 — دمج من روابط، بث Range 206، مهمة مختلطة (رابط + ملف مرفوع على أجزاء)، رفض >10 مصادر، JSON تالف، حذف ثم 404.
- **دمج عبر MCP** بروابط مباشرة وبـ `task_ids` بالترتيب → MP4 نهائي + تحذير الـ24 ساعة، ورفض مقطع واحد وأكثر من 10 برسائل عربية صحيحة.
- نظّفت آثار الاختبار: حُذفت كل مهام الاختبار من Turso ومهام الدمج التجريبية من الخدمة، وبقي مفتاحkie الحقيقي جاهزًا.

---

## 8) الأمان

- لا أسرار في الكود أو Git: `.env*` في `.gitignore` منذ أول commit، ومفاتيح التوليد تُخزَّن في قاعدة البيانات وتظهر **مقنّعة دائمًا** (`ABCD123••••••••WXYZ`).
- لا يُعاد المفتاح الكامل في أي استجابة API.
- حماية اختيارية لـ `/mcp` عبر `MCP_ACCESS_TOKEN`.
