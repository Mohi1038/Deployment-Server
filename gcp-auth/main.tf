terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 4.0.0"
    }
  }
}

variable "credentials" {
  type        = string
  description = "GCP Service Account JSON credentials string"
}

variable "project_id" {
  type        = string
  description = "GCP Project ID"
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "GCP default region"
}

variable "zone" {
  type        = string
  default     = "us-central1-a"
  description = "GCP default zone"
}

variable "create_vm" {
  type        = bool
  default     = false
  description = "Whether to provision the Compute Engine VM"
}

variable "vm_name" {
  type        = string
  default     = "devlups-app-vm"
}

variable "machine_type" {
  type        = string
  default     = "e2-micro"
}

variable "startup_script" {
  type        = string
  default     = ""
}

variable "app_ports" {
  type        = list(string)
  default     = ["80", "443", "3000", "5000"]
}

provider "google" {
  credentials = var.credentials 
  project     = var.project_id
  region      = var.region
  zone        = var.zone
}

data "google_project" "verify" {
  project_id = var.project_id
}

output "project_number" {
  value = "Project Number: ${data.google_project.verify.number}"
}

output "verification_status" {
  value = "Verified! GCP Account has access to Project: ${data.google_project.verify.name} (ID: ${data.google_project.verify.project_id})"
}

resource "google_compute_firewall" "app_firewall" {
  count   = var.create_vm ? 1 : 0
  name    = "${var.vm_name}-fw"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = var.app_ports
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = [var.vm_name]
}

resource "google_compute_instance" "app_instance" {
  count        = var.create_vm ? 1 : 0
  name         = var.vm_name
  machine_type = var.machine_type
  zone         = var.zone
  tags         = [var.vm_name, "http-server", "https-server"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 20
    }
  }

  network_interface {
    network = "default"
    access_config {
      // Ephemeral public IP
    }
  }

  metadata_startup_script = var.startup_script
}

output "instance_ip" {
  value = var.create_vm && length(google_compute_instance.app_instance) > 0 ? google_compute_instance.app_instance[0].network_interface[0].access_config[0].nat_ip : null
}
