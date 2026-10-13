# =============================================================================
# /projects/{projectId}/native-intents/{intentId}/discussions* — task-2 native
# execution discussions and advisory Quorum, served by the discussions Lambda.
# Distinct resources from the platform intent routes: the handler selects the
# native scope only from these paths and authorizes through protected native
# records (never the projection graph or a path fallback). No edit/apply or
# approval route exists under this tree.
# =============================================================================

locals {
  native_discussions_enabled = var.native_preparation_enabled && var.native_execution_enabled
}

resource "aws_api_gateway_resource" "native_discussions" {
  count       = local.native_discussions_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.native_intent[0].id
  path_part   = "discussions"
}
resource "aws_api_gateway_resource" "native_discussions_search" {
  count       = local.native_discussions_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.native_discussions[0].id
  path_part   = "search"
}
resource "aws_api_gateway_resource" "native_discussion" {
  count       = local.native_discussions_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.native_discussions[0].id
  path_part   = "{discussionId}"
}
resource "aws_api_gateway_resource" "native_discussion_messages" {
  count       = local.native_discussions_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.native_discussion[0].id
  path_part   = "messages"
}
resource "aws_api_gateway_resource" "native_discussion_message" {
  count       = local.native_discussions_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.native_discussion_messages[0].id
  path_part   = "{messageId}"
}
resource "aws_api_gateway_resource" "native_discussion_message_redact" {
  count       = local.native_discussions_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.native_discussion_message[0].id
  path_part   = "redact"
}
resource "aws_api_gateway_resource" "native_discussion_read" {
  count       = local.native_discussions_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.native_discussion[0].id
  path_part   = "read"
}
resource "aws_api_gateway_resource" "native_discussion_assist" {
  count       = local.native_discussions_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.native_discussion[0].id
  path_part   = "assist"
}

locals {
  native_discussion_routes = local.native_discussions_enabled ? {
    list_get      = { resource = aws_api_gateway_resource.native_discussions[0].id, method = "GET" }
    create_post   = { resource = aws_api_gateway_resource.native_discussions[0].id, method = "POST" }
    search_get    = { resource = aws_api_gateway_resource.native_discussions_search[0].id, method = "GET" }
    item_put      = { resource = aws_api_gateway_resource.native_discussion[0].id, method = "PUT" }
    read_put      = { resource = aws_api_gateway_resource.native_discussion_read[0].id, method = "PUT" }
    messages_get  = { resource = aws_api_gateway_resource.native_discussion_messages[0].id, method = "GET" }
    messages_post = { resource = aws_api_gateway_resource.native_discussion_messages[0].id, method = "POST" }
    redact_post   = { resource = aws_api_gateway_resource.native_discussion_message_redact[0].id, method = "POST" }
    assist_post   = { resource = aws_api_gateway_resource.native_discussion_assist[0].id, method = "POST" }
  } : {}
  native_discussion_cors_resources = local.native_discussions_enabled ? {
    discussions    = aws_api_gateway_resource.native_discussions[0].id
    search         = aws_api_gateway_resource.native_discussions_search[0].id
    discussion     = aws_api_gateway_resource.native_discussion[0].id
    messages       = aws_api_gateway_resource.native_discussion_messages[0].id
    message_redact = aws_api_gateway_resource.native_discussion_message_redact[0].id
    read           = aws_api_gateway_resource.native_discussion_read[0].id
    assist         = aws_api_gateway_resource.native_discussion_assist[0].id
  } : {}
}

resource "aws_api_gateway_method" "native_discussion" {
  for_each      = local.native_discussion_routes
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = each.value.resource
  http_method   = each.value.method
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "native_discussion" {
  for_each                = local.native_discussion_routes
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = each.value.resource
  http_method             = aws_api_gateway_method.native_discussion[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.discussions_lambda_invoke_arn
  # Complete preflight before a deployment snapshot can include these routes.
  depends_on = [module.cors_native_discussion]
}

module "cors_native_discussion" {
  source      = "./cors"
  for_each    = local.native_discussion_cors_resources
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = each.value
}

# The discussions Lambda's existing broad ($API/*/*) invoke permission covers
# these routes, exactly as for the platform intent discussion routes.
