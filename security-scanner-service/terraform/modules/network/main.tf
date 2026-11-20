# Our own VPC with one public subnet and two private worker subnets.
variable "region" { type = string }

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  az = data.aws_availability_zones.available.names[0]
  # AWS services the SAST workers reach through private endpoints instead of NAT.
  interface_endpoints = ["sqs", "ecr.api", "ecr.dkr", "logs"]
}

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "scanner-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "scanner-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.20.1.0/24"
  availability_zone       = local.az
  map_public_ip_on_launch = true
  tags                    = { Name = "scanner-public" }
}

resource "aws_subnet" "sast" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.2.0/24"
  availability_zone = local.az
  tags              = { Name = "scanner-private-sast" }
}

resource "aws_subnet" "pentest" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.3.0/24"
  availability_zone = local.az
  tags              = { Name = "scanner-private-pentest" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "scanner-nat-eip" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id
  tags          = { Name = "scanner-nat" }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "scanner-rtb-public" }
}

# No default route, SAST workers have no internet access at all
resource "aws_route_table" "sast" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "scanner-rtb-sast" }
}

resource "aws_route_table" "pentest" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
  tags = { Name = "scanner-rtb-pentest" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "sast" {
  subnet_id      = aws_subnet.sast.id
  route_table_id = aws_route_table.sast.id
}

resource "aws_route_table_association" "pentest" {
  subnet_id      = aws_subnet.pentest.id
  route_table_id = aws_route_table.pentest.id
}

resource "aws_vpc_endpoint" "gateway" {
  for_each          = toset(["s3", "dynamodb"])
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.sast.id, aws_route_table.pentest.id]
  tags              = { Name = "scanner-${each.key}-endpoint" }
}

resource "aws_security_group" "endpoints" {
  name        = "scanner-endpoints-sg"
  description = "HTTPS from inside the VPC to the interface endpoints"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(local.interface_endpoints)
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.sast.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = { Name = "scanner-${each.key}-endpoint" }
}

output "vpc_id" { value = aws_vpc.main.id }
output "public_subnet_id" { value = aws_subnet.public.id }
output "sast_subnet_id" { value = aws_subnet.sast.id }
output "pentest_subnet_id" { value = aws_subnet.pentest.id }
output "nat_public_ip" { value = aws_eip.nat.public_ip }
