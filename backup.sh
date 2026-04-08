#!/bin/bash
# Firestore 컬렉션 단위 백업/복원 스크립트
# 사용법:
#   ./backup.sh backup                    # 전체 주요 컬렉션 백업
#   ./backup.sh backup students contacts  # 특정 컬렉션만 백업
#   ./backup.sh list                      # 백업 목록 조회
#   ./backup.sh restore <백업경로> students  # 특정 컬렉션만 복원

PROJECT="impact7db"
BUCKET="gs://impact7db-backups"
COLLECTIONS="students contacts daily_records class_settings users director_users leave_requests onboardingTokens"

case "$1" in
  backup)
    shift
    TARGETS="${*:-$COLLECTIONS}"
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    DEST="${BUCKET}/${TIMESTAMP}"

    echo "=== Firestore 백업 ==="
    echo "대상: ${TARGETS}"
    echo "저장: ${DEST}"
    echo ""

    gcloud firestore export "$DEST" \
      --project="$PROJECT" \
      --collection-ids=$(echo $TARGETS | tr ' ' ',')

    if [ $? -eq 0 ]; then
      echo ""
      echo "백업 완료: ${DEST}"
    else
      echo "백업 실패!"
      exit 1
    fi
    ;;

  list)
    echo "=== 백업 목록 ==="
    gsutil ls "$BUCKET/" 2>/dev/null | sort -r | while read dir; do
      name=$(basename "$dir")
      echo "  $name  →  $dir"
    done
    ;;

  restore)
    if [ -z "$2" ]; then
      echo "사용법: ./backup.sh restore <백업폴더명> [컬렉션1 컬렉션2 ...]"
      echo ""
      echo "예시:"
      echo "  ./backup.sh restore 20260307_163000 students"
      echo "  ./backup.sh restore 20260307_163000 contacts students"
      echo ""
      echo "주의: 지정한 컬렉션만 복원됩니다. 다른 컬렉션은 영향 없음."
      exit 1
    fi

    BACKUP_NAME="$2"
    shift 2
    TARGETS="$*"

    if [ -z "$TARGETS" ]; then
      echo "복원할 컬렉션을 지정해주세요."
      echo "예: ./backup.sh restore ${BACKUP_NAME} students contacts"
      exit 1
    fi

    SOURCE="${BUCKET}/${BACKUP_NAME}"

    echo "=== Firestore 복원 ==="
    echo "백업: ${SOURCE}"
    echo "복원 대상: ${TARGETS}"
    echo ""
    echo "!! 주의: 지정한 컬렉션의 기존 데이터가 백업 시점으로 덮어씌워집니다 !!"
    echo ""
    read -p "계속하시겠습니까? (y/N): " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
      echo "취소됨."
      exit 0
    fi

    gcloud firestore import "$SOURCE" \
      --project="$PROJECT" \
      --collection-ids=$(echo $TARGETS | tr ' ' ',')

    if [ $? -eq 0 ]; then
      echo ""
      echo "복원 완료!"
    else
      echo "복원 실패!"
      exit 1
    fi
    ;;

  *)
    echo "Firestore 백업/복원 도구"
    echo ""
    echo "사용법:"
    echo "  ./backup.sh backup                      전체 주요 컬렉션 백업"
    echo "  ./backup.sh backup students contacts     특정 컬렉션만 백업"
    echo "  ./backup.sh list                         백업 목록 조회"
    echo "  ./backup.sh restore <폴더명> <컬렉션>    특정 컬렉션만 복원"
    ;;
esac
