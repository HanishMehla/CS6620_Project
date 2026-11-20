# API Gateway in front of the Submit Job Lambda.
variable "role_arn" { type = string }
variable "lambda_source_dir" { type = string }
variable "bucket" { type = string }
variable "jobs_table" { type = string }
variable "teams_table" { type = string }
variable "queue_urls" { type = map(string) }

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = var.lambda_source_dir
  output_path = "${path.module}/lambda.zip"
  excludes    = ["test", "package.json", "node_modules"]
}

resource "aws_cloudwatch_log_group" "submit" {
  name              = "/aws/lambda/scanner-submit-job"
  retention_in_days = 7
}

resource "aws_lambda_function" "submit" {
  function_name    = "scanner-submit-job"
  handler          = "submit.handler"
  runtime          = "nodejs22.x"
  role             = var.role_arn
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      BUCKET            = var.bucket
      JOBS_TABLE        = var.jobs_table
      TEAMS_TABLE       = var.teams_table
      SAST_QUEUE_URL    = var.queue_urls["sast"]
      PENTEST_QUEUE_URL = var.queue_urls["pentest"]
    }
  }

  depends_on = [aws_cloudwatch_log_group.submit]
}

resource "aws_apigatewayv2_api" "http" {
  name          = "scanner-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

resource "aws_apigatewayv2_integration" "submit" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.submit.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "submit" {
  for_each  = toset(["POST /jobs", "POST /jobs/{jobId}/start"])
  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.submit.id}"
}

resource "aws_lambda_permission" "api" {
  function_name = aws_lambda_function.submit.function_name
  action        = "lambda:InvokeFunction"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

output "api_url" { value = trimsuffix(aws_apigatewayv2_stage.default.invoke_url, "/") }
