# Resolve the actual deployment attestation and read-only IAM with mock services.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_region" { defaults = { region = "us-east-1" } }
  mock_data "aws_partition" { defaults = { partition = "aws", dns_suffix = "amazonaws.com" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/test" } }
  mock_resource "aws_lambda_function" {
    defaults = {
      arn              = "arn:aws:lambda:us-east-1:123456789012:function:recovery-v2-orchestrator-test"
      qualified_arn    = "arn:aws:lambda:us-east-1:123456789012:function:recovery-v2-orchestrator-test:17"
      version          = "17"
      source_code_hash = "published-package-hash"
    }
  }
  mock_resource "aws_sqs_queue" { defaults = { arn = "arn:aws:sqs:us-east-1:123456789012:test" } }
  mock_data "aws_iam_policy_document" { defaults = { json = "{}" } }
}
mock_provider "external" {
  mock_data "external" {
    defaults = { result = {
      filename            = "builds/mock.zip"
      build_plan          = "{}"
      build_plan_filename = "builds/mock.plan.json"
      timestamp           = "1"
    } }
  }
}
mock_provider "local" {}
mock_provider "null" {}

variables {
  project_name                             = "recovery"
  environment                              = "test"
  powertools_service_name                  = "test"
  powertools_log_level                     = "INFO"
  powertools_log_event                     = false
  application_url                          = "https://example.test"
  vpc_id                                   = "test"
  private_subnet_ids                       = ["subnet-0123456789abcdef0"]
  lambda_vpc_scope                         = "public-egress"
  neptune_endpoint                         = "test"
  neptune_cluster_resource_id              = "test"
  dynamodb_table_arns                      = []
  artifacts_bucket_name                    = "test"
  artifacts_bucket_arn                     = "arn:aws:s3:::recovery-test"
  blocks_table_name                        = "test"
  blocks_table_arn                         = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  aidlc_repo_ref                           = "test"
  cognito_user_pool_id                     = "test"
  cognito_user_pool_arn                    = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_test"
  realtime_doc_secret_param_arn            = "arn:aws:ssm:us-east-1:123456789012:parameter/realtime"
  realtime_doc_secret_param_name           = "test"
  agent_credential_grant_secret_param_arn  = "arn:aws:ssm:us-east-1:123456789012:parameter/grant"
  agent_credential_grant_secret_param_name = "test"
  discussion_locks_table_name              = "test"
  discussion_locks_table_arn               = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  discussion_read_state_table_name         = "test"
  discussion_read_state_table_arn          = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  connections_table_name                   = "test"
  connections_table_arn                    = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  websocket_api_endpoint_https             = "https://example.test"
  websocket_execution_arn                  = "arn:aws:execute-api:us-east-1:123456789012:api/test"
  v2_executions_table_name                 = "test"
  v2_executions_table_arn                  = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  yjs_documents_table_name                 = "test"
  yjs_documents_table_arn                  = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  agentcore_runtime_arn                    = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/core-abcdefghij"
  environment_registry_table_name          = "test"
  environment_registry_table_arn           = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  core_image_digest                        = "test"
  core_runtime_version                     = "test"
  runtime_compatibility_version            = "test"
}

run "preservation_recovery_deployment" {
  command = plan
  module { source = "./modules/api/lambda" }
  # A local fixture stands in for the built ZIP: exercise the module's real
  # file SHA-256 calculation rather than inventing the attested package hash.
  override_resource {
    target          = module.v2_orchestrator_lambda.terraform_data.package_filename_for_hash[0]
    override_during = plan
    values = {
      output = { filename = "../lambda/shared/recovery-capabilities.json" }
    }
  }
  assert {
    condition     = local.recovery_orchestrator_release.functionArn == "arn:aws:lambda:us-east-1:123456789012:function:recovery-v2-orchestrator-test:17" && local.recovery_orchestrator_release.codeSha256 == filebase64sha256("../lambda/shared/recovery-capabilities.json")
    error_message = "Recovery must attest the published version and actual package hash."
  }
  assert {
    condition     = local.recovery_orchestrator_release.schemaVersion == 1 && contains(local.recovery_orchestrator_release.capabilities, "checked-runtime-dispatch@1") && contains(local.recovery_orchestrator_release.capabilities, "preserve-integrated-section@1")
    error_message = "Deployment must propagate the packaged preservation and dispatch capabilities."
  }
  assert {
    condition     = alltrue([for action in ["lambda:GetAlias", "lambda:GetFunctionConfiguration"] : anytrue([for statement in jsondecode(aws_iam_role_policy.intents.policy).Statement : contains(statement.Action, action) && statement.Resource == local.v2_orchestrator_function_arns])])
    error_message = "Intents must read the configured orchestrator version without broadening its scope."
  }
  assert {
    condition     = anytrue([for statement in jsondecode(aws_iam_role_policy.intents.policy).Statement : contains(statement.Action, "bedrock-agentcore:GetAgentRuntimeEndpoint")]) && !anytrue([for statement in jsondecode(aws_iam_role_policy.intents.policy).Statement : contains(statement.Action, "bedrock-agentcore:UpdateAgentRuntimeEndpoint")])
    error_message = "Recovery can inspect endpoints but must not retarget them."
  }
}
