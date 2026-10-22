#!/usr/bin/env bash
# One-time Google Cloud setup for docs/DEPLOY.md, run in Google Cloud Shell (no install needed):
#
#   git clone -b claude/project-thread-joz1m0 https://github.com/hamcoec-dot/Results && cd Results && bash tools/setup-gcp.sh
#
# Creates both Firebase projects if they don't exist yet, links them to the billing account of an
# existing project (BILLING_FROM, default ballotboxdelivery; or set BILLING_ACCOUNT=<id>), and
# creates their Firestore databases in us-east1. Safe to run again: anything that already exists is
# left as it is. At the end it prints the three GitHub repository variables to copy into GitHub.
# Still done by hand in the Firebase console: Storage "Get started", Email/Password sign-in, admins.
#
# Other project ids (if the default ones were taken): bash tools/setup-gcp.sh <prod-id> <staging-id>
set -uo pipefail

PROD=${1:-hcec-election-results}
STAGING=${2:-hcec-election-results-staging}
REPO=hamcoec-dot/Results
POOL_PROJECT=$PROD
SA_NAME=github-deploy

ok()   { echo "  ok: $*"; }
step() { echo; echo "== $*"; }
fail() { echo; echo "STOPPED: $*"; echo "Copy everything above this line and send it to Claude."; exit 1; }

BILLING_FROM=${BILLING_FROM:-ballotboxdelivery}

create_project() {
  local p=$1
  step "$p: project"
  if gcloud projects describe "$p" --format='value(projectId)' >/dev/null 2>&1; then
    ok "project already exists"
  else
    gcloud projects create "$p" --name="$p" \
      || fail "could not create project $p. Project ids are shared across all of Google, so it may be taken."
    ok "project created"
  fi

  if [ "$(gcloud billing projects describe "$p" --format='value(billingEnabled)' 2>/dev/null)" = "True" ]; then
    ok "billing (Blaze) already on"
  else
    gcloud billing projects link "$p" --billing-account="$BILLING_ACCOUNT" >/dev/null \
      || fail "could not link billing account $BILLING_ACCOUNT to $p"
    ok "billing (Blaze) on"
  fi

  gcloud services enable firebase.googleapis.com firestore.googleapis.com --project="$p" \
    || fail "could not turn on Firebase for $p"
  if curl -sf -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "X-Goog-User-Project: $p" \
       "https://firebase.googleapis.com/v1beta1/projects/$p" >/dev/null; then
    ok "Firebase already on"
  else
    curl -sf -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "X-Goog-User-Project: $p" \
      -H "Content-Type: application/json" -d '{}' \
      "https://firebase.googleapis.com/v1beta1/projects/$p:addFirebase" >/dev/null \
      || fail "could not add Firebase to $p"
    for _ in $(seq 1 30); do
      curl -sf -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "X-Goog-User-Project: $p" \
        "https://firebase.googleapis.com/v1beta1/projects/$p" >/dev/null && break
      sleep 5
    done
    ok "Firebase added"
  fi

  if gcloud firestore databases describe --database='(default)' --project="$p" >/dev/null 2>&1; then
    ok "Firestore database already exists"
  else
    gcloud firestore databases create --database='(default)' --location=us-east1 --type=firestore-native \
      --project="$p" >/dev/null || fail "could not create the Firestore database in $p"
    ok "Firestore database created (us-east1)"
  fi
}

if [ -z "${BILLING_ACCOUNT:-}" ]; then
  BILLING_ACCOUNT=$(gcloud billing projects describe "$BILLING_FROM" --format='value(billingAccountName)' 2>/dev/null)
  BILLING_ACCOUNT=${BILLING_ACCOUNT#billingAccounts/}
fi
[ -n "$BILLING_ACCOUNT" ] || fail "could not find the billing account of $BILLING_FROM. Run: gcloud billing accounts list"
echo "Billing account: $BILLING_ACCOUNT (the one $BILLING_FROM uses)"

create_project "$STAGING"
create_project "$PROD"

POOL_NUMBER=$(gcloud projects describe "$POOL_PROJECT" --format='value(projectNumber)')

setup_project() {
  local p=$1
  local bucket="$p-results"
  local number sa compute
  number=$(gcloud projects describe "$p" --format='value(projectNumber)')
  sa="$SA_NAME@$p.iam.gserviceaccount.com"
  compute="$number-compute@developer.gserviceaccount.com"

  step "$p: turning on the Google services the app uses (takes a minute or two)"
  gcloud services enable --project="$p" \
    cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    eventarc.googleapis.com pubsub.googleapis.com cloudscheduler.googleapis.com firestore.googleapis.com \
    firebaserules.googleapis.com firebasestorage.googleapis.com storage.googleapis.com iam.googleapis.com \
    iamcredentials.googleapis.com sts.googleapis.com monitoring.googleapis.com logging.googleapis.com \
    cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
    || fail "could not turn on the services for $p. Is the project on the Blaze plan?"
  ok "services on"

  step "$p: public results bucket gs://$bucket"
  if gcloud storage buckets describe "gs://$bucket" >/dev/null 2>&1; then
    ok "bucket already exists"
  else
    gcloud storage buckets create "gs://$bucket" --project="$p" --location=us-east1 --uniform-bucket-level-access \
      || fail "could not create gs://$bucket (bucket names are global, so it may be taken)."
    ok "bucket created"
  fi
  # Anyone may read a file by its exact name; nobody may list the bucket (keeps draft links unguessable).
  gcloud storage buckets add-iam-policy-binding "gs://$bucket" --member=allUsers \
    --role=roles/storage.legacyObjectReader >/dev/null \
    || fail "could not make gs://$bucket publicly readable. If this is a county Google account, an organization policy may block public access; send this to Claude."
  gcloud storage buckets update "gs://$bucket" --cors-file=cors.json >/dev/null || fail "CORS on gs://$bucket"
  gcloud storage buckets update "gs://$bucket" --lifecycle-file=lifecycle.json >/dev/null || fail "lifecycle on gs://$bucket"
  ok "public read (no listing), CORS, drafts deleted after 2 days"

  step "$p: permissions for the app's functions"
  gcloud storage buckets add-iam-policy-binding "gs://$bucket" --member="serviceAccount:$compute" \
    --role=roles/storage.objectAdmin >/dev/null || fail "functions access to gs://$bucket"
  # New projects build functions with this account, and it needs the builder role to do so.
  gcloud projects add-iam-policy-binding "$p" --member="serviceAccount:$compute" \
    --role=roles/cloudbuild.builds.builder --condition=None >/dev/null || fail "builder role on $p"
  ok "functions can write the public bucket and be built"

  step "$p: the deploy account GitHub signs in as ($sa)"
  if gcloud iam service-accounts describe "$sa" --project="$p" >/dev/null 2>&1; then
    ok "account already exists"
  else
    gcloud iam service-accounts create "$SA_NAME" --project="$p" --display-name="GitHub deploy" \
      || fail "could not create $sa"
    sleep 10 # a new account takes a few seconds to be usable
  fi
  for role in roles/firebase.admin roles/cloudfunctions.admin roles/run.admin roles/iam.serviceAccountUser \
              roles/storage.admin roles/firebaserules.admin roles/cloudscheduler.admin \
              roles/artifactregistry.admin roles/serviceusage.serviceUsageConsumer; do
    gcloud projects add-iam-policy-binding "$p" --member="serviceAccount:$sa" --role="$role" \
      --condition=None >/dev/null || fail "role $role for $sa"
  done
  ok "deploy roles granted"

  # Only GitHub Actions runs from hamcoec-dot/Results may act as this account.
  gcloud iam service-accounts add-iam-policy-binding "$sa" --project="$p" --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/projects/$POOL_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO" \
    >/dev/null || fail "GitHub sign-in for $sa"
  ok "GitHub (only $REPO) can sign in as it"
}

step "GitHub sign-in (Workload Identity Federation) in $POOL_PROJECT"
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project="$POOL_PROJECT" \
  || fail "could not turn on the IAM services in $POOL_PROJECT"
if gcloud iam workload-identity-pools describe github --project="$POOL_PROJECT" --location=global >/dev/null 2>&1; then
  ok "pool already exists"
else
  gcloud iam workload-identity-pools create github --project="$POOL_PROJECT" --location=global \
    --display-name="GitHub Actions" || fail "could not create the identity pool"
fi
if gcloud iam workload-identity-pools providers describe github --project="$POOL_PROJECT" --location=global \
     --workload-identity-pool=github >/dev/null 2>&1; then
  ok "provider already exists"
else
  gcloud iam workload-identity-pools providers create-oidc github --project="$POOL_PROJECT" --location=global \
    --workload-identity-pool=github --display-name="GitHub" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository == '$REPO'" || fail "could not create the identity provider"
fi

setup_project "$STAGING"
setup_project "$PROD"

echo
echo "================================================================"
echo "DONE. Add these three in GitHub: Settings > Secrets and variables > Actions > Variables tab > New repository variable"
echo
echo "  GCP_WIF_PROVIDER       projects/$POOL_NUMBER/locations/global/workloadIdentityPools/github/providers/github"
echo "  GCP_DEPLOY_SA_STAGING  $SA_NAME@$STAGING.iam.gserviceaccount.com"
echo "  GCP_DEPLOY_SA_PROD     $SA_NAME@$PROD.iam.gserviceaccount.com"
echo "================================================================"
echo
echo "Still to do by hand at console.firebase.google.com, in both projects (see the setup guide):"
echo "  Storage > Get started (production mode, us-east1); Authentication > Email/Password on, sign-up off;"
echo "  add yourself as a user and as a document in the admins collection."
