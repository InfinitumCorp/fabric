package app.infinitumfabric.client.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.infinitumfabric.client.FabricViewModel
import app.infinitumfabric.client.Screen
import app.infinitumfabric.client.domain.formatUsdFromCents

@Composable
fun FabricApp(model: FabricViewModel, openCumulusId: (create: Boolean) -> Unit = {}) {
    BackHandler(enabled = model.screen !is Screen.SignIn && model.screen !is Screen.Chats) {
        model.back()
    }
    Scaffold(containerColor = Paper) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 20.dp, vertical = 16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("FabriC++", style = MaterialTheme.typography.headlineMedium)
            Text("Infinitum Corporation®", style = MaterialTheme.typography.bodySmall)
            Text("End-to-end encrypted cyber messaging", style = MaterialTheme.typography.bodySmall)
            if (model.busy) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth(), color = Accent, trackColor = Line)
            }
            model.error?.let { Text(it, color = Ink, style = MaterialTheme.typography.bodyMedium) }
            model.notice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            HorizontalDivider(color = Line, thickness = 1.dp)
            when (val screen = model.screen) {
                Screen.SignIn -> SignIn(model, openCumulusId)
                Screen.Chats -> Chats(model)
                is Screen.Conversation -> Conversation(model, screen.handle)
                Screen.NewChat -> NewChat(model)
                is Screen.Contact -> Contact(model, screen.handle)
                Screen.Settings -> Settings(model)
                Screen.Plan -> Plan(model)
                Screen.Data -> Data(model)
            }
        }
    }
}

@Composable
fun LockedScreen() {
    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("FabriC++", style = MaterialTheme.typography.headlineMedium)
        Text("Infinitum Corporation®", style = MaterialTheme.typography.bodySmall)
        Text("The encrypted session store could not be opened. Sign-in is off.")
    }
}

@Composable
private fun SignIn(model: FabricViewModel, openCumulusId: (create: Boolean) -> Unit) {
    Text("Sign in", style = MaterialTheme.typography.titleMedium)
    Text(
        "FabriC++ signs you in with your Cumulus ID. No password is stored in the app.",
        style = MaterialTheme.typography.bodySmall,
    )
    Button(
        onClick = { openCumulusId(false) },
        enabled = !model.busy,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("cid-sign-in"),
        shape = MaterialTheme.shapes.small,
        colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = Paper),
    ) { Text("Sign in with Cumulus ID") }
    OutlinedButton(
        onClick = { openCumulusId(true) },
        enabled = !model.busy,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("cid-create"),
        shape = MaterialTheme.shapes.small,
        border = BorderStroke(1.dp, Ink),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = Ink),
    ) { Text("Create a Cumulus ID") }
    Text(
        "No Cumulus ID yet? Create one in the same step. You come back here signed in.",
        style = MaterialTheme.typography.bodySmall,
    )
    TextButton(onClick = model::toggleAdvanced, modifier = Modifier.testTag("advanced")) {
        Text(if (model.showAdvanced) "Hide advanced" else "Advanced", color = Accent)
    }
    if (model.showAdvanced) {
        OutlinedTextField(
            value = model.baseUrl,
            onValueChange = model::updateBaseUrl,
            modifier = Modifier
                .fillMaxWidth()
                .testTag("homeserver"),
            label = { Text("Relay") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        TextButton(onClick = model::checkRelay, enabled = !model.busy) { Text("Check relay", color = Accent) }
        Text("Cumulus ID ${model.cidIssuer}", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun Chats(model: FabricViewModel) {
    NavRow(model)
    Text("Chats", style = MaterialTheme.typography.titleMedium)
    if (model.chats.isEmpty()) {
        Text("No chats yet. Messages are not sent by this build.", style = MaterialTheme.typography.bodySmall)
    }
    model.chats.forEach { chat ->
        TextButton(onClick = { model.open(Screen.Conversation(chat.handle)) }) {
            Text(chat.handle, color = Ink)
        }
    }
    PrimaryButton("New chat", { model.open(Screen.NewChat) })
}

@Composable
private fun NewChat(model: FabricViewModel) {
    Text("New chat", style = MaterialTheme.typography.titleMedium)
    Text("Enter a handle. The chat stays on this device.", style = MaterialTheme.typography.bodySmall)
    OutlinedTextField(
        value = model.handle,
        onValueChange = model::updateHandle,
        modifier = Modifier.fillMaxWidth(),
        label = { Text("Handle") },
        singleLine = true,
    )
    PrimaryButton("Create", { model.addChat(model.handle) })
    TextButton(onClick = { model.open(Screen.Chats) }) { Text("Back", color = Accent) }
}

@Composable
private fun Conversation(model: FabricViewModel, handle: String) {
    Text(handle, style = MaterialTheme.typography.titleMedium)
    Text("Not verified", style = MaterialTheme.typography.bodySmall)
    Text("Encryption state is unknown. Sending is off.", style = MaterialTheme.typography.bodyMedium)
    Text(
        "This build has no Matrix crypto module, so it will not send plaintext. " +
            "Unable to decrypt is what an encrypted event would show.",
        style = MaterialTheme.typography.bodySmall,
    )
    TextButton(onClick = { model.open(Screen.Contact(handle)) }) { Text("Contact", color = Accent) }
    TextButton(onClick = { model.open(Screen.Chats) }) { Text("Back", color = Accent) }
}

@Composable
private fun Contact(model: FabricViewModel, handle: String) {
    Text(handle, style = MaterialTheme.typography.titleMedium)
    Text("Verification: not verified. SAS comparison is not in this build.", style = MaterialTheme.typography.bodySmall)
    Text(
        "Block and report stay on this screen. The relay's HTTP API has no block or report route, " +
            "and this build does not open a socket.",
        style = MaterialTheme.typography.bodySmall,
    )
    TextButton(onClick = { model.open(Screen.Chats) }) { Text("Back", color = Accent) }
}

@Composable
private fun Plan(model: FabricViewModel) {
    NavRow(model)
    Text("Plan", style = MaterialTheme.typography.titleMedium)
    Text("Personal is free. Live checkout is not available yet.", style = MaterialTheme.typography.bodySmall)
    val preview = model.preview
    if (preview == null) {
        Text("No preview yet.", style = MaterialTheme.typography.bodySmall)
    } else {
        Text("Eligible revenue ${formatUsdFromCents(preview.revenueCents)}")
        Text("User pool ${formatUsdFromCents(preview.poolCents)} (70%)")
        Text("Infinitum Corporation® ${formatUsdFromCents(preview.infinitumCents)}")
        Text("Participants ${preview.participants}. FAB per USD ${preview.fabPerUsd}.")
        Text("Per-person amounts stay on the signed-in socket. This screen does not settle.", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun Data(model: FabricViewModel) {
    NavRow(model)
    Text("Data revenue", style = MaterialTheme.typography.titleMedium)
    Text(
        "Off until you opt in. Counts would be messages and calls, never contents or recipients. " +
            "Share is 70% with a ledger on the relay. Payouts are not active in this build. " +
            "Toggles stay on this device.",
        style = MaterialTheme.typography.bodySmall,
    )
    if (model.purposes.isEmpty()) {
        Text("No purposes loaded.", style = MaterialTheme.typography.bodySmall)
    }
    model.purposes.forEach { purpose ->
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.weight(1f)) {
                Text(purpose.label)
                Text(purpose.detail, style = MaterialTheme.typography.bodySmall)
            }
            Switch(
                checked = model.consent[purpose.key] == true,
                onCheckedChange = { model.toggleConsent(purpose.key, it) },
            )
        }
    }
}

@Composable
private fun Settings(model: FabricViewModel) {
    NavRow(model)
    Text("Settings", style = MaterialTheme.typography.titleMedium)
    model.profile?.let { Text("Signed in with Cumulus ID as ${it.display}.") }
    Text("Relay ${model.baseUrl}", style = MaterialTheme.typography.bodySmall)
    val ledger = model.ledger
    val relay = model.relay
    if (ledger != null) {
        Text("Ledger ${if (ledger.valid) "valid" else "not valid"}, length ${ledger.length}.")
        Text("Head ${ledger.head.take(16)}", style = MaterialTheme.typography.bodySmall)
    }
    if (relay != null) {
        Text("Cumulus://ID ${if (relay.cidEnabled) "on" else "off"}, required ${relay.cidRequired}.")
        Text("Calls: SFU ${relay.sfu}, TURN ${relay.turn}, ICE servers ${relay.iceServerCount}.")
        Text("On-device models listed: ${relay.modelsAvailable}.")
    }
    Text("Devices: none registered from this build.", style = MaterialTheme.typography.bodySmall)
    PrimaryButton("Sign out", model::signOut)
}

@Composable
private fun NavRow(model: FabricViewModel) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        TextButton(onClick = { model.open(Screen.Chats) }) { Text("Chats", color = Accent) }
        TextButton(onClick = { model.open(Screen.Plan) }) { Text("Plan", color = Accent) }
        TextButton(onClick = { model.open(Screen.Data) }) { Text("Data", color = Accent) }
        TextButton(onClick = { model.open(Screen.Settings) }) { Text("Settings", color = Accent) }
    }
}

@Composable
private fun PrimaryButton(label: String, onClick: () -> Unit, enabled: Boolean = true) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.small,
        colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = Paper),
    ) { Text(label) }
    Spacer(Modifier.height(0.dp))
}
