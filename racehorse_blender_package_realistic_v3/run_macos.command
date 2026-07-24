#!/bin/bash
# ============================================================
# run_macos.command
# تشغيل حزمة خيل السباق الواقعي v3 على macOS
#
# الاستخدام:
#   - انقر نقرًا مزدوجًا على هذا الملف من Finder
#   - أو من الطرفية:  ./run_macos.command
#
# السلوك:
#   1) إذا وُجد ملف racehorse_realistic_v3.blend يفتحه في Blender.
#   2) إذا لم يوجد، يعيد بناء المشهد كاملًا من السكربت.
# ============================================================
set -e
cd "$(dirname "$0")"

# البحث عن Blender في المواقع المعتادة على macOS
BLENDER=""
for CAND in \
    "/Applications/Blender.app/Contents/MacOS/Blender" \
    "$HOME/Applications/Blender.app/Contents/MacOS/Blender" \
    "$(command -v blender || true)"
do
    if [ -n "$CAND" ] && [ -x "$CAND" ]; then
        BLENDER="$CAND"
        break
    fi
done

if [ -z "$BLENDER" ]; then
    echo "❌ لم يتم العثور على Blender."
    echo "   ثبّت Blender من https://www.blender.org/download/"
    echo "   ثم أعد تشغيل هذا الملف."
    read -p "اضغط Enter للإغلاق..."
    exit 1
fi

echo "✅ تم العثور على Blender: $BLENDER"

if [ -f "racehorse_realistic_v3.blend" ]; then
    echo "🐎 فتح ملف المشهد الجاهز racehorse_realistic_v3.blend ..."
    "$BLENDER" "racehorse_realistic_v3.blend"
else
    echo "🔨 لم يوجد ملف .blend — إعادة بناء المشهد من السكربت (قد يستغرق دقائق) ..."
    "$BLENDER" --background --python "build_racehorse_blender_v3.py"
    echo "✅ اكتمل البناء. افتح racehorse_realistic_v3.blend في Blender."
fi
