# Deploy jambonz-retell-bridge to AWS ECS Fargate + ALB (us-east-2)
#
# Prerequisites:
#   - AWS CLI configured (account 673931177446)
#   - Docker running
#   - ACM certificate ARN for your public hostname (required for jambonz wss://)
#
# Usage:
#   .\scripts\deploy-aws-bridge.ps1 -CertificateArn "arn:aws:acm:us-east-2:673931177446:certificate/..." -Hostname "bridge.example.com"
#
# Before first deploy, copy Render env vars into Secrets Manager:
#   aws secretsmanager put-secret-value --secret-id vqtech/prod/JAMBONZ_RETELL_BRIDGE --secret-string '{...}'

param(
  [string]$Region = "us-east-2",
  [string]$AccountId = "673931177446",
  [string]$Cluster = "vqtech-prod",
  [string]$ServiceName = "jambonz-retell-bridge",
  [string]$Repository = "vqtech/jambonz-retell-bridge",
  [string]$SecretName = "vqtech/prod/JAMBONZ_RETELL_BRIDGE",
  [string]$CertificateArn = "",
  [string]$Hostname = "",
  [string[]]$SubnetIds = @("subnet-08d6a3f2e6cb86bcc", "subnet-04846a7be1ba30bc8", "subnet-06c3c96e203bae5f9"),
  [string]$VpcId = "vpc-074d29b13f814c34a",
  [switch]$SkipDockerBuild
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EcrUri = "$AccountId.dkr.ecr.$Region.amazonaws.com/$Repository"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

function Invoke-AwsCli {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $output = & aws @Args 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($exitCode -ne 0) { return $null }
  return ($output | Out-String).Trim()
}

function Ensure-SecurityGroup {
  param(
    [string]$GroupName,
    [string]$Description
  )
  $existing = Invoke-AwsCli ec2 describe-security-groups `
    --filters "Name=group-name,Values=$GroupName" "Name=vpc-id,Values=$VpcId" `
    --region $Region --query "SecurityGroups[0].GroupId" --output text
  if ($existing -and $existing -ne "None") {
    return $existing
  }
  $sgId = Invoke-AwsCli ec2 create-security-group `
    --group-name $GroupName `
    --description $Description `
    --vpc-id $VpcId `
    --region $Region `
    --query GroupId --output text
  if (-not $sgId) { throw "Failed to create security group $GroupName" }
  return $sgId
}

function Ensure-IngressRule {
  param(
    [string]$GroupId,
    [string]$Protocol,
    [int]$Port,
    [string]$Cidr = "",
    [string]$SourceGroupId = ""
  )
  if ($Cidr) {
    Invoke-AwsCli ec2 authorize-security-group-ingress `
      --group-id $GroupId `
      --protocol $Protocol `
      --port $Port `
      --cidr $Cidr `
      --region $Region | Out-Null
  } elseif ($SourceGroupId) {
    Invoke-AwsCli ec2 authorize-security-group-ingress `
      --group-id $GroupId `
      --protocol $Protocol `
      --port $Port `
      --source-group $SourceGroupId `
      --region $Region | Out-Null
  }
}

if (-not $SkipDockerBuild) {
  Write-Step "Logging into ECR"
  aws ecr get-login-password --region $Region | docker login --username AWS --password-stdin "$AccountId.dkr.ecr.$Region.amazonaws.com"

  Write-Step "Building and pushing Docker image"
  Push-Location $RepoRoot
  docker build -t "${Repository}:latest" .
  docker tag "${Repository}:latest" "${EcrUri}:latest"
  docker push "${EcrUri}:latest"
  Pop-Location
} else {
  Write-Step "Skipping Docker build/push (-SkipDockerBuild)"
}

Write-Step "Ensuring security groups"
$albSgName = "vqtech-bridge-alb-sg"
$ecsSgName = "vqtech-bridge-ecs-sg"
$AlbSecurityGroupId = Ensure-SecurityGroup -GroupName $albSgName -Description "Public ALB for jambonz-retell-bridge"
Ensure-IngressRule -GroupId $AlbSecurityGroupId -Protocol tcp -Port 80 -Cidr "0.0.0.0/0"
Ensure-IngressRule -GroupId $AlbSecurityGroupId -Protocol tcp -Port 443 -Cidr "0.0.0.0/0"
Write-Host "ALB security group: $AlbSecurityGroupId"

Write-Step "Ensuring Secrets Manager secret exists"
$defaultSecret = @{
  RETELL_API_KEY = "REPLACE_ME"
  RETELL_TRUNK_NAME = "Retell-73hR8GtTmfVmdn7kUbc1Fz"
  RETELL_SIP_CLIENT_USERNAME = "vqtech-retell"
  SKYSWITCH_CARRIER_NAME = "SkySwitch-JambonzRetell"
  SKYSWITCH_SIP_REALM = "visionquest.22393.service"
  SKYSWITCH_REGISTER_USERNAME = "JambonzRetell"
  OWN_DIDS = "+12297406150"
  OVERRIDE_FROM_USER = "+12297406150"
  DEFAULT_COUNTRY = "US"
} | ConvertTo-Json -Compress

$describe = Invoke-AwsCli secretsmanager describe-secret --secret-id $SecretName --region $Region
if (-not $describe) {
  $created = Invoke-AwsCli secretsmanager create-secret `
    --name $SecretName `
    --description "Runtime env for jambonz-retell-bridge" `
    --secret-string $defaultSecret `
    --region $Region
  if (-not $created) { throw "Failed to create secret $SecretName" }
  Write-Host "Created secret $SecretName with defaults; update RETELL_API_KEY before go-live"
} else {
  Write-Host "Secret $SecretName already exists (not overwriting; update manually if needed)"
}

$secretArn = Invoke-AwsCli secretsmanager describe-secret --secret-id $SecretName --region $Region --query ARN --output text
if (-not $secretArn) { throw "Failed to resolve secret ARN for $SecretName" }
Write-Host "Secret ARN: $secretArn"

$EcsSecurityGroupId = Ensure-SecurityGroup -GroupName $ecsSgName -Description "ECS tasks for jambonz-retell-bridge"
Ensure-IngressRule -GroupId $EcsSecurityGroupId -Protocol tcp -Port 3000 -SourceGroupId $AlbSecurityGroupId
Write-Host "ECS security group: $EcsSecurityGroupId"

Write-Step "Registering ECS task definition"
$taskDef = @{
  family = "vqtech-jambonz-retell-bridge"
  networkMode = "awsvpc"
  requiresCompatibilities = @("FARGATE")
  cpu = "256"
  memory = "512"
  executionRoleArn = "arn:aws:iam::${AccountId}:role/vqtech-prod-ecs-execution-role"
  taskRoleArn = "arn:aws:iam::${AccountId}:role/vqtech-prod-ecs-task-role"
  runtimePlatform = @{
    cpuArchitecture = "X86_64"
    operatingSystemFamily = "LINUX"
  }
  containerDefinitions = @(
    @{
      name = "bridge"
      image = "${EcrUri}:latest"
      essential = $true
      portMappings = @(
        @{
          containerPort = 3000
          hostPort = 3000
          protocol = "tcp"
          name = "bridge-3000-tcp"
          appProtocol = "http"
        }
      )
      secrets = @(
        "RETELL_API_KEY", "RETELL_TRUNK_NAME", "RETELL_SIP_CLIENT_USERNAME",
        "SKYSWITCH_CARRIER_NAME", "SKYSWITCH_SIP_REALM", "SKYSWITCH_REGISTER_USERNAME",
        "OWN_DIDS", "OVERRIDE_FROM_USER", "DEFAULT_COUNTRY"
      ) | ForEach-Object {
        @{ name = $_; valueFrom = "${secretArn}:$($_)::" }
      }
      environment = @(
        @{ name = "NODE_ENV"; value = "production" },
        @{ name = "LOGLEVEL"; value = "info" },
        @{ name = "PORT"; value = "3000" }
      )
      logConfiguration = @{
        logDriver = "awslogs"
        options = @{
          "awslogs-group" = "/ecs/vqtech-jambonz-retell-bridge"
          "awslogs-create-group" = "true"
          "awslogs-region" = $Region
          "awslogs-stream-prefix" = "ecs"
        }
      }
      healthCheck = @{
        command = @("CMD-SHELL", "curl -fsS http://localhost:3000/health || exit 1")
        interval = 30
        timeout = 5
        retries = 3
        startPeriod = 60
      }
    }
  )
} | ConvertTo-Json -Depth 10

$taskDefFile = Join-Path $env:TEMP "vqtech-jambonz-retell-bridge-taskdef.json"
[System.IO.File]::WriteAllText($taskDefFile, $taskDef, [System.Text.UTF8Encoding]::new($false))
$taskDefArn = Invoke-AwsCli ecs register-task-definition --cli-input-json "file://$($taskDefFile -replace '\\','/')" --region $Region --query 'taskDefinition.taskDefinitionArn' --output text
if (-not $taskDefArn) { throw "Failed to register ECS task definition" }
Write-Host "Task definition: $taskDefArn"

Write-Step "Ensuring ALB + target group"
$albName = "vqtech-bridge-alb"
$tgName = "vqtech-bridge-tg"

$existingAlbsJson = Invoke-AwsCli elbv2 describe-load-balancers --names $albName --region $Region
if ($existingAlbsJson) {
  $existingAlbs = $existingAlbsJson | ConvertFrom-Json
} else {
  $existingAlbs = @{ LoadBalancers = @() }
}
if ($existingAlbs.LoadBalancers.Count -gt 0) {
  $albArn = $existingAlbs.LoadBalancers[0].LoadBalancerArn
  $albDns = $existingAlbs.LoadBalancers[0].DNSName
  Write-Host "Using existing ALB: $albDns"
} else {
  $subnetArgs = @()
  foreach ($subnetId in $SubnetIds) {
    $subnetArgs += @("--subnets", $subnetId)
  }
  $albArn = Invoke-AwsCli elbv2 create-load-balancer `
    @subnetArgs `
    --name $albName `
    --security-groups $AlbSecurityGroupId `
    --scheme internet-facing `
    --type application `
    --ip-address-type ipv4 `
    --region $Region `
    --query 'LoadBalancers[0].LoadBalancerArn' --output text
  if (-not $albArn) { throw "Failed to create ALB $albName" }
  $albDns = Invoke-AwsCli elbv2 describe-load-balancers --load-balancer-arns $albArn --region $Region --query 'LoadBalancers[0].DNSName' --output text
  Write-Host "Created ALB: $albDns"
}

$existingTgsJson = Invoke-AwsCli elbv2 describe-target-groups --names $tgName --region $Region
if ($existingTgsJson) {
  $existingTgs = $existingTgsJson | ConvertFrom-Json
} else {
  $existingTgs = @{ TargetGroups = @() }
}
if ($existingTgs.TargetGroups.Count -gt 0) {
  $tgArn = $existingTgs.TargetGroups[0].TargetGroupArn
} else {
  $tgArn = Invoke-AwsCli elbv2 create-target-group `
    --name $tgName `
    --protocol HTTP `
    --port 3000 `
    --vpc-id $VpcId `
    --target-type ip `
    --health-check-path /health `
    --health-check-interval-seconds 30 `
    --region $Region `
    --query 'TargetGroups[0].TargetGroupArn' --output text
  if (-not $tgArn) { throw "Failed to create target group $tgName" }
}

# ALB idle timeout for long voice calls
aws elbv2 modify-load-balancer-attributes `
  --load-balancer-arn $albArn `
  --attributes Key=idle_timeout.timeout_seconds,Value=3600 `
  --region $Region | Out-Null

Write-Step "Configuring ALB listener"
if ($CertificateArn) {
  $listeners = aws elbv2 describe-listeners --load-balancer-arn $albArn --region $Region | ConvertFrom-Json
  $httpsListener = $listeners.Listeners | Where-Object { $_.Port -eq 443 }
  if (-not $httpsListener) {
    aws elbv2 create-listener `
      --load-balancer-arn $albArn `
      --protocol HTTPS `
      --port 443 `
      --certificates CertificateArn=$CertificateArn `
      --default-actions Type=forward,TargetGroupArn=$tgArn `
      --region $Region | Out-Null
    aws elbv2 create-listener `
      --load-balancer-arn $albArn `
      --protocol HTTP `
      --port 80 `
      --default-actions Type=redirect,RedirectConfig="{Protocol=HTTPS,Port=443,StatusCode=HTTP_301}" `
      --region $Region | Out-Null
  }
  $publicUrl = "https://$Hostname"
} else {
  Write-Host "WARNING: No CertificateArn - creating HTTP listener only. jambonz requires wss:// for production cutover." -ForegroundColor Yellow
  $listeners = aws elbv2 describe-listeners --load-balancer-arn $albArn --region $Region | ConvertFrom-Json
  $httpListener = $listeners.Listeners | Where-Object { $_.Port -eq 80 }
  if (-not $httpListener) {
    aws elbv2 create-listener `
      --load-balancer-arn $albArn `
      --protocol HTTP `
      --port 80 `
      --default-actions Type=forward,TargetGroupArn=$tgArn `
      --region $Region | Out-Null
  }
  $publicUrl = "http://$albDns"
}

Write-Step "Creating/updating ECS service"
$existingService = aws ecs describe-services --cluster $Cluster --services $ServiceName --region $Region | ConvertFrom-Json
if ($existingService.services.Count -gt 0 -and $existingService.services[0].status -ne "INACTIVE") {
  aws ecs update-service `
    --cluster $Cluster `
    --service $ServiceName `
    --task-definition $taskDefArn `
    --force-new-deployment `
    --region $Region | Out-Null
  Write-Host "Updated ECS service $ServiceName"
} else {
  $subnetList = ($SubnetIds | ForEach-Object { "`"$_`"" }) -join ','
  $networkConfigObj = @{
    awsvpcConfiguration = @{
      subnets = $SubnetIds
      securityGroups = @($EcsSecurityGroupId)
      assignPublicIp = "ENABLED"
    }
  }
  $loadBalancersObj = @(
    @{
      targetGroupArn = $tgArn
      containerName = "bridge"
      containerPort = 3000
    }
  )
  $deploymentConfigObj = @{
    maximumPercent = 200
    minimumHealthyPercent = 100
    deploymentCircuitBreaker = @{
      enable = $true
      rollback = $true
    }
  }

  $networkConfigFile = Join-Path $env:TEMP "vqtech-bridge-network.json"
  $loadBalancersFile = Join-Path $env:TEMP "vqtech-bridge-lb.json"
  $deploymentConfigFile = Join-Path $env:TEMP "vqtech-bridge-deploy.json"
  [System.IO.File]::WriteAllText($networkConfigFile, ($networkConfigObj | ConvertTo-Json -Depth 5 -Compress), [System.Text.UTF8Encoding]::new($false))
  $loadBalancersJson = if ($loadBalancersObj.Count -eq 1) {
    '[' + ($loadBalancersObj[0] | ConvertTo-Json -Depth 5 -Compress) + ']'
  } else {
    $loadBalancersObj | ConvertTo-Json -Depth 5 -Compress
  }
  [System.IO.File]::WriteAllText($loadBalancersFile, $loadBalancersJson, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($deploymentConfigFile, ($deploymentConfigObj | ConvertTo-Json -Depth 5 -Compress), [System.Text.UTF8Encoding]::new($false))

  $created = Invoke-AwsCli ecs create-service `
    --cluster $Cluster `
    --service-name $ServiceName `
    --task-definition $taskDefArn `
    --desired-count 1 `
    --launch-type FARGATE `
    --platform-version LATEST `
    --network-configuration "file://$($networkConfigFile -replace '\\','/')" `
    --load-balancers "file://$($loadBalancersFile -replace '\\','/')" `
    --health-check-grace-period-seconds 120 `
    --deployment-configuration "file://$($deploymentConfigFile -replace '\\','/')" `
    --region $Region
  if (-not $created) { throw "Failed to create ECS service $ServiceName" }
  Write-Host "Created ECS service $ServiceName"
}

Write-Step "Deployment initiated"
Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Update secret with real values from Render (especially RETELL_API_KEY)"
Write-Host "2. Request ACM cert if needed, then re-run with -CertificateArn and -Hostname"
Write-Host "3. Point DNS CNAME to ALB: $albDns"
Write-Host "4. Verify: curl $publicUrl/health"
Write-Host "5. Update jambonz webhook to wss://YOUR-HOSTNAME/retell"
Write-Host "6. Test call + warm transfer, then shut down Render"
Write-Host ""
Write-Host "ALB DNS: $albDns"
