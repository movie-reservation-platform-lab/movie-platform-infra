#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${AWS_STUB_AWS_MARKER}"

if [[ "${1:-}" == '--version' ]]; then
  printf '%s\n' "${AWS_STUB_VERSION}"
  exit 0
fi

if [[ "${1:-}" == 'configure' && "${2:-}" == 'get' ]]; then
  if [[ "${3:-}" == '--sso-session' ]]; then
    key="${5:-}"
  else
    key="${3:-}"
  fi

  case "${key}" in
    sso_account_id) value="${AWS_STUB_PROFILE_ACCOUNT:-}" ;;
    sso_role_name) value="${AWS_STUB_PROFILE_PERMISSION_SET:-}" ;;
    sso_session) value="${AWS_STUB_PROFILE_SSO_SESSION:-}" ;;
    region) value="${AWS_STUB_PROFILE_REGION:-}" ;;
    sso_region) value="${AWS_STUB_SSO_REGION:-}" ;;
    aws_access_key_id) value="${AWS_STUB_PROFILE_ACCESS_KEY:-}" ;;
    aws_secret_access_key) value="${AWS_STUB_PROFILE_SECRET_KEY:-}" ;;
    aws_session_token) value="${AWS_STUB_PROFILE_SESSION_TOKEN:-}" ;;
    credential_process) value="${AWS_STUB_PROFILE_CREDENTIAL_PROCESS:-}" ;;
    credential_source) value="${AWS_STUB_PROFILE_CREDENTIAL_SOURCE:-}" ;;
    role_arn) value="${AWS_STUB_PROFILE_ROLE_ARN:-}" ;;
    source_profile) value="${AWS_STUB_PROFILE_SOURCE_PROFILE:-}" ;;
    web_identity_token_file) value="${AWS_STUB_PROFILE_WEB_IDENTITY_TOKEN_FILE:-}" ;;
    login_session) value="${AWS_STUB_PROFILE_LOGIN_SESSION:-}" ;;
    *) exit 2 ;;
  esac

  [[ -n "${value}" ]] || exit 1
  printf '%s\n' "${value}"
  exit 0
fi

if [[ "${1:-}" == 'sts' && "${2:-}" == 'get-caller-identity' ]]; then
  printf '%s\n' "$*" >"${AWS_STUB_STS_MARKER}"
  if [[ "${AWS_STUB_STS_FAILURE:-false}" == 'true' ]]; then
    printf 'private AWS CLI diagnostic: %s\n' "${AWS_STUB_CALLER_ARN}" >&2
    exit 23
  fi
  printf '%s\t%s\n' "${AWS_STUB_CALLER_ACCOUNT}" "${AWS_STUB_CALLER_ARN}"
  exit 0
fi

printf 'unexpected aws invocation\n' >&2
exit 2
