/*
 * Spyy Search Node.js backend
 *
 * Created by Nathan Tejuco
 * 
 * Last updated April 8 2017
 */
'use strict';

const 
  express = require('express'),
  request = require('request'),
  jsdom = require('jsdom'),
  bodyParser = require("body-parser"),
  fs = require('fs');

var app = express();
app.set('port', process.env.PORT || 5000);
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(bodyParser.json({ verify: verifyRequestSignature }));

// Open file containing secret keys
const credentials = JSON.parse(fs.readFileSync('credentials.js', 'utf8'));

// Extract keys from file
const 
  GOOGLE_CSE_KEY = credentials.googleKey,
  VALIDATION_TOKEN = credentials.validationToken,
  APP_KEY = credentials.appSecret;


// Validate Facebook webhook
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);          
  }  
});

app.post('/webhook', function (req, res) {
  var data = req.body;

  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    res.sendStatus(200);
  }
});

/*
 *Verify callback came from Facebook
*/
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an 
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_KEY)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("Received message for user %d and page %d at %d with message:", 
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // Message will either contain text or attachment
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Just logging message echoes to console
    console.log("Received echo for message %s and app %d with metadata %s", 
      messageId, appId, metadata);
    return;
  } else if (quickReply) {
  	// Should never recieve a quick reply
    var quickReplyPayload = quickReply.payload;
    console.log("Quick reply for message %s with payload %s",
      messageId, quickReplyPayload);

    sendTextMessage(senderID, "Quick reply tapped");
    return;
  }

  if (messageText) {
    searchForProductLinks(senderID, messageText);
  } else if (messageAttachments) {
  	processAttachment(senderID, messageAttachments);
    sendTextMessage(senderID, "Message with attachment received");
  }
}

function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log("Received delivery confirmation for message ID: %s", 
        messageID);
    });
  }

  console.log("All message before %d were delivered.", watermark);
}

// App should not send Structured Message, so this should never be called
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp; 
  var payload = event.postback.payload;

  console.log("Received postback for user %d and page %d with payload '%s' " + 
    "at %d", senderID, recipientID, payload, timeOfPostback);

  sendTextMessage(senderID, "Postback called");
}

function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText
    }
  };

  callSendAPI(messageData);
}

function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s", 
          messageId, recipientId);
      } else {
      console.log("Successfully called Send API for recipient %s", 
        recipientId);
      }
    } else {
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });  
}

function processAttachment(recipientID, messageAttachments){
  if (messageAttachments.type == "image"){
  	imageSearch(recipientID, messageAttachments.payload.url);
  } else {
  	sendTextMessage(recipientID, "Please send an image or the product name");
  }
}

function imageSearch(recipientID, imageSource){
  var options = {
    url: 'https://images.google.com/searchbyimage?image_url=www.nathantejuco.com/spry/' + imageSource,
	headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux i686) AppleWebKit/537.11 (KHTML, like Gecko) Chrome/23.0.1271.64 Safari/537.11' }
	};
  request(options, function (err, res, body) {
  	// If no error from Google Image Search, scrape best guess 
  	// from HTML then query Google CSE  

    if (!err){ 
  	  jsdom.env(
        html,
 	    ["http://code.jquery.com/jquery.js"],
  	    function (err, window) {
          searchForProductLinks(recipientID, window.$("a._gUb").text());
  	    }
      );
  	}

  });
}

/*
 * Queries Google CSE, domains searched are:
 *   amazon.com
 *   ebay.com
 * Page title and links are extracted and sent to user
 */

function searchForProductLinks(recipientID, searchQuery){
  var options = {
    url: 'https://www.googleapis.com/customsearch/v1?key='+GOOGLE_CSE_KEY+'&cx=011733113756967906305:ptssd3i06cq&q='+searchQuery,
  };
  titles = [];
  links = [];
  request(options, function (err, res, body) {
    if (!err){
  	  searchItems = JSON.parse(body).items;
  	  for (var i=0; i<searchItems.length; i++) {
  	    titles.push(searchItems[i].title);
  		links.push(searchItems[i].link);
  	  }
  	  console.log(titles);
  	}
  });
  if (title.length == 0) {
  	sendTextMessage(recipientID, "Oops, we can't determine what that product is");
  } else {
  	for (var i=0; i<title.length; i++){
  	  sendTextMessage(recipientID, title[i]);
  	  sendTextMessage(recipientID, link[i])
  	}
  }
}

// Start the server
app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});